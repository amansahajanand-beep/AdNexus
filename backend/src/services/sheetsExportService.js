/**
 * Daily Google Sheets export (GAM + AdMob + AdSense).
 *
 * Each user connects their own spreadsheet from the frontend (table user_sheet_exports) and shares it with
 * our service account. Rows are upserted by key (date + client [+ site / app / account]), so re-running updates
 * existing rows and appends new ones. Non-admin users only ever get rows inside their assigned scope.
 *
 * Env:
 *   GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON  path to the key file OR the inline JSON
 */
const fs = require('fs');
const { google } = require('googleapis');
const { query } = require('../db');
const logger = require('../utils/logger');
const { getUserById } = require('../models/userStore');
const store = require('../models/sheetExportStore');
const {
  isAdmin, hasFlag, getAdmobScope, getAdsenseScope, getUserInventoryScope,
} = require('../utils/permissions');
const { getDateRestriction, clampDateRange } = require('../utils/dateRestriction');
const { shiftYMD } = require('../utils/datetime');
const { getClientById, getAccountIdForClient, listClientsByAccountId } = require('../models/clientStore');
const { getAllowedClientIds } = require('../utils/permissions');
const { resolvePublisherClient } = require('../utils/publisherTenant');
const { admobAccountStore, adsenseAccountStore } = require('../models/publisherAccountStore');
const admobGrain = require('../models/admobGrainStore');
const adsenseGrain = require('../models/adsenseGrainStore');

const CATALOG_DAYS = 90; // the Catalog tab lists everything that had traffic in this many days

function num(v) {
  if (v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : '';
}

const ecpm = (rev, imp) => (Number(imp) > 0 ? (Number(rev) / Number(imp)) * 1000 : 0);
const pct = (part, whole) => (Number(whole) > 0 ? (Number(part) / Number(whole)) * 100 : 0);
/** SQL: show the network name, or one "All networks" label when the flag parameter is true (domain users). */
const CLIENT_LABEL = (flag) => `CASE WHEN ${flag}::boolean THEN 'All networks' ELSE c.name END`;
/** The hidden publisher workspace is named "<network> · AdMob"; show the real name. */
const cleanClient = (name) => String(name || '').replace(/\s*·\s*AdMob$/, '');

/**
 * One entry per tab.
 *   kind   — which part of the user's scope applies (see resolveScope)
 *   params — SQL parameters; $1/$2 = date range, $3 = client, the rest come from the scope
 * rollup_kpi_daily holds the main rows (inv_app = '') plus separate app rows (web columns empty, inv_app set)
 * that overlap them, so totals use inv_app = '' and the Apps tab uses the app rows. Never sum both.
 */
const SOURCES = {
  GAM: {
    tab: 'GAM',
    kind: 'domains',
    header: ['Date', 'Client', 'Revenue', 'Impressions', 'Clicks', 'eCPM', 'Currency'],
    keyCols: 2,
    // $3 = every network to read, $6 = merge them into one "All networks" row set (domain users).
    params: (r, ids, sc, merged) => [r.startDate, r.endDate, ids, sc.domains, sc.sites, merged],
    sql: `
      SELECT r.report_date::text AS d, ${CLIENT_LABEL('$6')} AS client,
             SUM(r.revenue) AS revenue, SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks,
             MAX(r.currency) AS currency
        FROM rollup_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = ANY($3::uuid[]) AND r.inv_app = ''
         AND ($4::text[] IS NULL OR lower(r.inv_domain) = ANY($4::text[]) OR lower(r.inv_site) = ANY($5::text[]))
       GROUP BY r.report_date, ${CLIENT_LABEL('$6')}
       ORDER BY r.report_date, client`,
    row: (x) => [x.d, x.client, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Sites': {
    tab: 'GAM Sites',
    kind: 'domains',
    header: ['Date', 'Client', 'Domain', 'Site', 'Revenue', 'Impressions', 'Clicks', 'eCPM', 'Currency'],
    keyCols: 4,
    params: (r, ids, sc, merged) => [r.startDate, r.endDate, ids, sc.domains, sc.sites, merged],
    sql: `
      SELECT r.report_date::text AS d, ${CLIENT_LABEL('$6')} AS client, r.inv_domain AS domain, r.inv_site AS site,
             SUM(r.revenue) AS revenue, SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks,
             MAX(r.currency) AS currency
        FROM rollup_inventory_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = ANY($3::uuid[])
         AND (r.inv_domain <> '' OR r.inv_site <> '')
         AND ($4::text[] IS NULL OR lower(r.inv_domain) = ANY($4::text[]) OR lower(r.inv_site) = ANY($5::text[]))
       GROUP BY r.report_date, ${CLIENT_LABEL('$6')}, r.inv_domain, r.inv_site
       ORDER BY r.report_date, client, r.inv_domain, r.inv_site`,
    row: (x) => [x.d, x.client, x.domain, x.site, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Apps': {
    tab: 'GAM Apps',
    kind: 'apps',
    header: ['Date', 'Client', 'App ID', 'App Name', 'Revenue', 'Impressions', 'Clicks', 'eCPM', 'Currency'],
    keyCols: 3,
    params: (r, ids, sc, merged) => [r.startDate, r.endDate, ids, sc.appIds, merged],
    sql: `
      SELECT r.report_date::text AS d, ${CLIENT_LABEL('$5')} AS client, r.inv_app AS app_id,
             COALESCE(MAX(n.app_name), '') AS app_name,
             SUM(r.revenue) AS revenue, SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks,
             MAX(r.currency) AS currency
        FROM rollup_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
        LEFT JOIN (
          SELECT lower(app_id) AS k, MAX(app_name) AS app_name FROM rollup_app_country_daily
           WHERE client_id = ANY($3::uuid[]) GROUP BY lower(app_id)
        ) n ON n.k = lower(r.inv_app)
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = ANY($3::uuid[])
         AND r.inv_domain = '' AND r.inv_site = '' AND r.inv_ad_unit = '' AND r.inv_app <> ''
         AND ($4::text[] IS NULL OR lower(r.inv_app) = ANY($4::text[]))
       GROUP BY r.report_date, ${CLIENT_LABEL('$5')}, r.inv_app
       ORDER BY r.report_date, client, r.inv_app`,
    row: (x) => [x.d, x.client, x.app_id, x.app_name, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Countries': {
    tab: 'GAM Countries',
    kind: 'network', // network-wide only: this rollup can't be cut by a user's domains/apps
    header: ['Date', 'Client', 'Country', 'Revenue', 'Impressions', 'Clicks', 'eCPM', 'Currency'],
    keyCols: 3,
    params: (r, ids, sc, merged) => [r.startDate, r.endDate, ids, merged],
    sql: `
      SELECT r.report_date::text AS d, ${CLIENT_LABEL('$4')} AS client,
             COALESCE(NULLIF(dc.name, ''), 'Unknown') AS country,
             SUM(r.revenue) AS revenue, SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks,
             MAX(r.currency) AS currency
        FROM rollup_country_device_daily r
        JOIN gam_clients c ON c.id = r.client_id
        LEFT JOIN dim_country dc ON dc.id = r.country_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = ANY($3::uuid[])
       GROUP BY r.report_date, ${CLIENT_LABEL('$4')}, COALESCE(NULLIF(dc.name, ''), 'Unknown')
       ORDER BY r.report_date, client, country`,
    row: (x) => [x.d, x.client, x.country, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Catalog': {
    tab: 'GAM Catalog',
    kind: 'catalog', // a list, not daily numbers: everything that had traffic in the last CATALOG_DAYS days
    header: ['Type', 'Client', 'Domain', 'Site', 'App ID', 'App Name', 'Ad Unit'],
    keyCols: 7,
    params: (r, ids, sc, merged) => [shiftYMD(r.endDate, -(CATALOG_DAYS - 1)), r.endDate, ids, sc.domains, sc.sites, sc.appIds, merged],
    sql: `
      SELECT 'Site' AS type, ${CLIENT_LABEL('$7')} AS client, r.inv_domain AS domain, r.inv_site AS site,
             '' AS app_id, '' AS app_name, r.inv_ad_unit AS ad_unit
        FROM rollup_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = ANY($3::uuid[]) AND r.inv_app = ''
         AND (r.inv_domain <> '' OR r.inv_site <> '' OR r.inv_ad_unit <> '')
         AND ($4::text[] IS NULL OR lower(r.inv_domain) = ANY($4::text[]) OR lower(r.inv_site) = ANY($5::text[]))
       GROUP BY ${CLIENT_LABEL('$7')}, r.inv_domain, r.inv_site, r.inv_ad_unit
      UNION ALL
      SELECT 'App', ${CLIENT_LABEL('$7')}, '', '', a.inv_app, COALESCE(MAX(n.app_name), ''), ''
        FROM (
          SELECT DISTINCT client_id, inv_app FROM rollup_kpi_daily
           WHERE report_date BETWEEN $1 AND $2 AND client_id = ANY($3::uuid[])
             AND inv_domain = '' AND inv_site = '' AND inv_ad_unit = '' AND inv_app <> ''
             AND ($6::text[] IS NULL OR lower(inv_app) = ANY($6::text[]))
        ) a
        JOIN gam_clients c ON c.id = a.client_id
        LEFT JOIN (
          SELECT lower(app_id) AS k, MAX(app_name) AS app_name FROM rollup_app_country_daily
           WHERE client_id = ANY($3::uuid[]) GROUP BY lower(app_id)
        ) n ON n.k = lower(a.inv_app)
       GROUP BY ${CLIENT_LABEL('$7')}, a.inv_app
      ORDER BY 1, 3, 4, 7, 5`,
    row: (x) => [x.type, x.client, x.domain, x.site, x.app_id, x.app_name, x.ad_unit],
  },
  AdMob: {
    tab: 'AdMob',
    kind: 'admob',
    scopedRows: scopedAdmobRows,
    header: ['Date', 'Client', 'Account', 'Earnings', 'Impressions', 'Clicks', 'Ad Requests',
      'Matched Requests', 'CTR', 'eCPM', 'Match Rate', 'Currency'],
    keyCols: 3,
    // $3 is a LIST of client ids: AdMob data lives under the publisher workspace, but older data may sit
    // under the GAM network itself, so every candidate is read (an account row only exists under one).
    params: (r, clientIds, sc) => [r.startDate, r.endDate, clientIds, sc.admobIds],
    sql: `
      SELECT f.report_date::text AS d, c.name AS client,
             COALESCE(NULLIF(a.descriptive_name, ''), a.account_id, 'AdMob') AS account,
             SUM(f.earnings) AS earnings, SUM(f.impressions) AS impressions, SUM(f.clicks) AS clicks,
             SUM(f.ad_requests) AS ad_requests, SUM(f.matched_requests) AS matched_requests,
             MAX(a.currency_code) AS currency
        FROM admob_report_daily f
        LEFT JOIN admob_accounts a ON a.id = f.account_id
        JOIN gam_clients c ON c.id = f.client_id
       WHERE f.report_date BETWEEN $1 AND $2 AND f.client_id = ANY($3::uuid[])
         AND ($4::text[] IS NULL OR f.account_id::text = ANY($4::text[]))
       GROUP BY f.report_date, c.name, COALESCE(NULLIF(a.descriptive_name, ''), a.account_id, 'AdMob')
       ORDER BY f.report_date, c.name, account`,
    row: (x) => [x.d, cleanClient(x.client), x.account, num(x.earnings), num(x.impressions), num(x.clicks),
      num(x.ad_requests), num(x.matched_requests),
      num(pct(x.clicks, x.impressions)), num(ecpm(x.earnings, x.impressions)),
      num(pct(x.matched_requests, x.ad_requests)), x.currency || 'USD'],
  },
  AdSense: {
    tab: 'AdSense',
    kind: 'adsense',
    scopedRows: scopedAdsenseRows,
    header: ['Date', 'Client', 'Account', 'Earnings', 'Page Views', 'Impressions', 'Clicks',
      'CTR', 'RPM', 'eCPM', 'Currency'],
    keyCols: 3,
    params: (r, clientIds, sc) => [r.startDate, r.endDate, clientIds, sc.adsenseIds],
    sql: `
      SELECT f.report_date::text AS d, c.name AS client,
             COALESCE(NULLIF(a.descriptive_name, ''), a.account_id, 'AdSense') AS account,
             SUM(f.earnings) AS earnings, SUM(f.page_views) AS page_views,
             SUM(f.impressions) AS impressions, SUM(f.clicks) AS clicks,
             MAX(a.currency_code) AS currency
        FROM adsense_report_daily f
        LEFT JOIN adsense_accounts a ON a.id = f.account_id
        JOIN gam_clients c ON c.id = f.client_id
       WHERE f.report_date BETWEEN $1 AND $2 AND f.client_id = ANY($3::uuid[])
         AND ($4::text[] IS NULL OR f.account_id::text = ANY($4::text[]))
       GROUP BY f.report_date, c.name, COALESCE(NULLIF(a.descriptive_name, ''), a.account_id, 'AdSense')
       ORDER BY f.report_date, c.name, account`,
    row: (x) => [x.d, cleanClient(x.client), x.account, num(x.earnings), num(x.page_views), num(x.impressions),
      num(x.clicks), num(pct(x.clicks, x.impressions)), num(ecpm(x.earnings, x.page_views)),
      num(ecpm(x.earnings, x.impressions)), x.currency || 'USD'],
  },
};

/**
 * Domain users: read the same scoped grain facts their AdMob / AdSense pages use, cut to the accounts,
 * apps / ad units / sites the admin assigned. One row per day. Account names are never exposed to them.
 */
const sharedCurrency = (accounts) => {
  const set = new Set(accounts.map((a) => String(a.currencyCode || 'USD').toUpperCase()));
  return set.size === 1 ? [...set][0] : 'USD';
};

async function scopedAdmobRows({ range, tenant, scope }) {
  const allowed = new Set(scope.accountIds);
  const out = [];
  for (const id of tenant.ids) {
    const accounts = (await admobAccountStore.listAccounts(id)).filter((a) => allowed.has(a.id));
    if (!accounts.length) continue;
    const sc = { ...scope, accountIds: accounts.map((a) => a.id) };
    const trend = await admobGrain.scopedTrend(id, accounts, { start: range.startDate, end: range.endDate, scope: sc });
    const cur = sharedCurrency(accounts);
    for (const t of trend) {
      out.push([t.date, tenant.label, 'AdMob', num(t.earnings), num(t.impressions), num(t.clicks),
        num(t.ad_requests), num(t.matched_requests), num(t.ctr), num(t.ecpm), num(t.match_rate), cur]);
    }
  }
  return out;
}

async function scopedAdsenseRows({ range, tenant, scope }) {
  const allowed = new Set(scope.accountIds);
  const out = [];
  for (const id of tenant.ids) {
    const accounts = (await adsenseAccountStore.listAccounts(id)).filter((a) => allowed.has(a.id));
    if (!accounts.length) continue;
    const sc = { ...scope, accountIds: accounts.map((a) => a.id) };
    const trend = await adsenseGrain.scopedTrend(id, accounts, { start: range.startDate, end: range.endDate, scope: sc });
    for (const t of trend) {
      out.push([t.date, tenant.label, 'AdSense', num(t.earnings), num(t.page_views), num(t.impressions),
        num(t.clicks), num(t.ctr), num(t.rpm), num(ecpm(t.earnings, t.impressions)), 'USD']);
    }
  }
  return out;
}

function colLetter(n) { // 1 -> A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function loadCredentials() {
  const raw = (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is not set');
  const text = raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
  return JSON.parse(text);
}

async function getSheetsApi() {
  const auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, spreadsheetId, tab, header) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === tab);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] },
    });
  }
  const end = colLetter(header.length);
  const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A1:${end}1` });
  if (!head.data.values || !head.data.values[0] || head.data.values[0].join('|') !== header.join('|')) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${tab}'!A1:${end}1`, valueInputOption: 'RAW', requestBody: { values: [header] },
    });
  }
}

async function upsertTab(sheets, spreadsheetId, src, rows) {
  const { tab, header, keyCols } = src;
  await ensureTab(sheets, spreadsheetId, tab, header);
  const end = colLetter(header.length);
  const keyEnd = colLetter(keyCols);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${tab}'!A2:${keyEnd}`, valueRenderOption: 'FORMATTED_VALUE',
  });
  const keyToRow = new Map(); // key -> 1-based sheet row
  (existing.data.values || []).forEach((r, i) => {
    keyToRow.set(Array.from({ length: keyCols }, (_, k) => String(r[k] ?? '')).join('\u0001'), i + 2);
  });

  const updates = [];
  const appends = [];
  for (const values of rows) {
    const key = values.slice(0, keyCols).map((v) => String(v ?? '')).join('\u0001');
    const at = keyToRow.get(key);
    if (at) updates.push({ range: `'${tab}'!A${at}:${end}${at}`, values: [values] });
    else appends.push(values);
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId, requestBody: { valueInputOption: 'RAW', data: updates },
    });
  }
  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `'${tab}'!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appends },
    });
  }
  return { updated: updates.length, appended: appends.length };
}

/** Service-account email users must share their sheet with (null when not configured). */
function getServiceAccountEmail() {
  try { return loadCredentials().client_email || null; } catch { return null; }
}

/** Accepts a full Google Sheets URL or a bare spreadsheet id. */
function parseSpreadsheetId(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(raw) ? raw : null;
}

/** Confirms the service account can edit the sheet. Returns its title; throws a user-readable Error. */
async function verifyAccess(spreadsheetId) {
  const sheets = await getSheetsApi();
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties.title' });
    return meta.data.properties.title || '';
  } catch (err) {
    const status = err.code || err.response?.status;
    const e = new Error(status === 404 || status === 403
      ? 'Cannot open this sheet. Share it with the service account email (Editor access) and try again.'
      : `Google Sheets error: ${err.message}`);
    e.status = status === 404 || status === 403 ? 400 : 502;
    throw e;
  }
}

/**
 * What this user may export. Each filter is null (unrestricted) or an array (empty = nothing).
 * Returns { scope, skips } where skips[kind] explains why that kind of tab is not exported.
 */
function resolveScope(user) {
  if (isAdmin(user)) {
    return { scope: { domains: null, sites: null, appIds: null, admobIds: null, adsenseIds: null }, skips: {} };
  }
  const scope = { domains: [], sites: [], appIds: [], admobIds: [], adsenseIds: [], admob: null, adsense: null };
  const skips = {};
  if (!hasFlag(user, 'canDownloadReports') || user.permissions?.canSeeRevenue === false) {
    const msg = 'Your account is not allowed to download revenue reports';
    ['domains', 'apps', 'network', 'catalog', 'admob', 'adsense'].forEach((k) => { skips[k] = msg; });
    return { scope, skips };
  }
  const inv = getUserInventoryScope(user);
  scope.domains = inv?.domains ? [...inv.domains] : [];
  scope.sites = inv?.sites ? [...inv.sites] : [];
  scope.appIds = inv?.appIds ? [...inv.appIds] : [];
  if (!scope.domains.length && !scope.sites.length) skips.domains = 'No domains or sites assigned to your account';
  if (!scope.appIds.length) skips.apps = 'No apps assigned to your account';
  if (!scope.domains.length && !scope.sites.length && !scope.appIds.length) skips.catalog = 'No domains, sites or apps assigned to your account';
  skips.network = 'Country totals are only available for network-wide (admin) accounts';

  // AdMob / AdSense: any assigned accounts (optionally narrowed to apps / ad units / sites) are exported
  // through the scoped grain readers, so the sheet matches what the user sees in the app.
  const am = getAdmobScope(user);
  if (!am.accountIds.length) skips.admob = 'No AdMob accounts assigned';
  else scope.admob = am;

  const as = getAdsenseScope(user);
  if (!as.accountIds.length) skips.adsense = 'No AdSense accounts assigned';
  else scope.adsense = as;
  return { scope, skips };
}

/**
 * Push one user's scoped data to their connected sheet.
 * @param {{startDate:string,endDate:string,spreadsheetId:string,clientId:string,user:object}} opts
 */
async function exportDailyToSheets({ startDate, endDate, spreadsheetId, clientId, user }) {
  if (!spreadsheetId) throw new Error('No spreadsheet connected');
  const range = clampDateRange(startDate, endDate, getDateRestriction(user));
  const { scope, skips } = resolveScope(user);
  const sheets = await getSheetsApi();

  // GAM tabs cover every network the user can access (admin: all networks of the account;
  // domain user: the networks they're allowed). The connected network is always included.
  let networks;
  const networkIds = async () => {
    if (!networks) {
      networks = [clientId];
      try {
        const client = await getClientById(clientId);
        // The connected client may itself be the hidden AdMob workspace; its networks hang off the parent account.
        const accountId = client?.publisherParentId || await getAccountIdForClient(clientId);
        const all = (await listClientsByAccountId(accountId))
          .filter((n) => n.id && !n.isPending && n.isActive !== false);
        // A domain user's data is defined by their assigned domains / sites / apps, not by network, so every
        // network of the account is read and the scope filters decide what they get.
        networks = [...new Set([clientId, ...all.map((n) => n.id)])];
      } catch (err) {
        logger.warn(`Sheets export: network lookup failed, using the connected network only: ${err.message}`);
      }
    }
    return networks;
  };

  // AdMob / AdSense rows belong to the account's hidden publisher workspace, not the GAM network itself.
  // Every candidate client id is read so data is found wherever the sync stored it.
  let publisher;
  const publisherTenant = async () => {
    if (!publisher) {
      const client = await getClientById(clientId);
      const ws = await resolvePublisherClient(client);
      const ids = [...new Set([ws?.id, clientId, ...(await networkIds())].filter(Boolean))];
      publisher = { ids, label: isAdmin(user) ? cleanClient(ws?.name || client?.name || '') : 'All networks' };
    }
    return publisher;
  };

  const result = {};
  for (const [name, src] of Object.entries(SOURCES)) {
    if (skips[src.kind]) { result[name] = { skipped: skips[src.kind] }; continue; }
    if (range.startDate > range.endDate) { result[name] = { skipped: 'Date range outside your allowed window' }; continue; }
    try {
      let values;
      let scanned;
      if (src.kind === 'admob' || src.kind === 'adsense') {
        const tenant = await publisherTenant();
        scanned = tenant.ids.length;
        if (isAdmin(user)) {
          const res = await query(src.sql, src.params(range, tenant.ids, scope));
          values = res.rows.map(src.row);
        } else {
          values = await src.scopedRows({ range, tenant, scope: src.kind === 'admob' ? scope.admob : scope.adsense });
        }
      } else {
        const ids = await networkIds();
        scanned = ids.length;
        const res = await query(src.sql, src.params(range, ids, scope, !isAdmin(user)));
        values = res.rows.map(src.row);
      }
      const out = await upsertTab(sheets, spreadsheetId, src, values);
      result[name] = { fetched: values.length, scanned, ...out };
      if (!values.length) {
        result[name].note = src.kind === 'admob' || src.kind === 'adsense'
          ? `No ${name} rows found for these dates in ${scanned} workspace(s). Check that ${name} accounts are connected and synced.`
          : `No rows found for these dates across ${scanned} network(s).`;
      }
      logger.info(`Sheets export [${name}] user=${user.username} ${range.startDate}→${range.endDate}: ${values.length} rows (updated ${out.updated}, appended ${out.appended})`);
    } catch (err) {
      result[name] = { error: err.message };
      logger.error(`Sheets export [${name}] failed: ${err.message}`);
    }
  }
  return { startDate: range.startDate, endDate: range.endDate, tabs: result };
}

/** Run + record status for one saved connection row. Never throws. */
async function runConnection(conn, { startDate, endDate }) {
  try {
    const user = await getUserById(conn.user_id);
    if (!user || !user.isActive) throw new Error('User not found or inactive');
    const result = await exportDailyToSheets({
      startDate, endDate, spreadsheetId: conn.spreadsheet_id, clientId: conn.client_id, user,
    });
    const failed = Object.values(result.tabs).filter((t) => t.error);
    const ok = failed.length === 0;
    await store.recordRun(conn.user_id, { ok, error: failed.map((t) => t.error).join('; '), result });
    return { ok, result };
  } catch (err) {
    await store.recordRun(conn.user_id, { ok: false, error: err.message }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

/** Daily job: every enabled connection, startDate → endDate. */
async function runAllConnections({ startDate, endDate }) {
  const conns = await store.listEnabledConnections();
  const out = [];
  for (const conn of conns) out.push({ userId: conn.user_id, ...(await runConnection(conn, { startDate, endDate })) });
  return out;
}

module.exports = {
  SOURCES, resolveScope,
  exportDailyToSheets, runConnection, runAllConnections,
  getServiceAccountEmail, parseSpreadsheetId, verifyAccess,
};
