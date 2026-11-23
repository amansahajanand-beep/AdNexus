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
const { getClientById } = require('../models/clientStore');
const { resolvePublisherClient } = require('../utils/publisherTenant');

const CATALOG_DAYS = 90; // the Catalog tab lists everything that had traffic in this many days

function num(v) {
  if (v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : '';
}

const ecpm = (rev, imp) => (Number(imp) > 0 ? (Number(rev) / Number(imp)) * 1000 : 0);

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
    params: (r, client, sc) => [r.startDate, r.endDate, client, sc.domains],
    sql: `
      SELECT r.report_date::text AS d, c.name AS client,
             SUM(r.revenue) AS revenue, SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks,
             MAX(r.currency) AS currency
        FROM rollup_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = $3::uuid AND r.inv_app = ''
         AND ($4::text[] IS NULL OR lower(r.inv_domain) = ANY($4::text[]))
       GROUP BY r.report_date, c.name
       ORDER BY r.report_date, c.name`,
    row: (x) => [x.d, x.client, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Sites': {
    tab: 'GAM Sites',
    kind: 'domains',
    header: ['Date', 'Client', 'Domain', 'Site', 'Revenue', 'Impressions', 'Clicks', 'eCPM', 'Currency'],
    keyCols: 4,
    params: (r, client, sc) => [r.startDate, r.endDate, client, sc.domains],
    sql: `
      SELECT r.report_date::text AS d, c.name AS client, r.inv_domain AS domain, r.inv_site AS site,
             SUM(r.revenue) AS revenue, SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks,
             MAX(r.currency) AS currency
        FROM rollup_inventory_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = $3::uuid
         AND (r.inv_domain <> '' OR r.inv_site <> '')
         AND ($4::text[] IS NULL OR lower(r.inv_domain) = ANY($4::text[]))
       GROUP BY r.report_date, c.name, r.inv_domain, r.inv_site
       ORDER BY r.report_date, c.name, r.inv_domain, r.inv_site`,
    row: (x) => [x.d, x.client, x.domain, x.site, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Apps': {
    tab: 'GAM Apps',
    kind: 'apps',
    header: ['Date', 'Client', 'App ID', 'App Name', 'Revenue', 'Impressions', 'Clicks', 'eCPM', 'Currency'],
    keyCols: 3,
    params: (r, client, sc) => [r.startDate, r.endDate, client, sc.appIds],
    sql: `
      SELECT r.report_date::text AS d, c.name AS client, r.inv_app AS app_id, COALESCE(n.app_name, '') AS app_name,
             r.revenue, r.impressions, r.clicks, r.currency
        FROM rollup_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
        LEFT JOIN (
          SELECT lower(app_id) AS k, MAX(app_name) AS app_name FROM rollup_app_country_daily
           WHERE client_id = $3::uuid GROUP BY lower(app_id)
        ) n ON n.k = lower(r.inv_app)
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = $3::uuid
         AND r.inv_domain = '' AND r.inv_site = '' AND r.inv_ad_unit = '' AND r.inv_app <> ''
         AND ($4::text[] IS NULL OR lower(r.inv_app) = ANY($4::text[]))
       ORDER BY r.report_date, c.name, r.inv_app`,
    row: (x) => [x.d, x.client, x.app_id, x.app_name, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Countries': {
    tab: 'GAM Countries',
    kind: 'network', // network-wide only: this rollup can't be cut by a user's domains/apps
    header: ['Date', 'Client', 'Country', 'Revenue', 'Impressions', 'Clicks', 'eCPM', 'Currency'],
    keyCols: 3,
    params: (r, client) => [r.startDate, r.endDate, client],
    sql: `
      SELECT r.report_date::text AS d, c.name AS client, COALESCE(NULLIF(dc.name, ''), 'Unknown') AS country,
             SUM(r.revenue) AS revenue, SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks,
             MAX(r.currency) AS currency
        FROM rollup_country_device_daily r
        JOIN gam_clients c ON c.id = r.client_id
        LEFT JOIN dim_country dc ON dc.id = r.country_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = $3::uuid
       GROUP BY r.report_date, c.name, COALESCE(NULLIF(dc.name, ''), 'Unknown')
       ORDER BY r.report_date, c.name, country`,
    row: (x) => [x.d, x.client, x.country, num(x.revenue), num(x.impressions), num(x.clicks),
      num(ecpm(x.revenue, x.impressions)), x.currency],
  },
  'GAM Catalog': {
    tab: 'GAM Catalog',
    kind: 'catalog', // a list, not daily numbers: everything that had traffic in the last CATALOG_DAYS days
    header: ['Type', 'Client', 'Domain', 'Site', 'App ID', 'App Name', 'Ad Unit'],
    keyCols: 7,
    params: (r, client, sc) => [shiftYMD(r.endDate, -(CATALOG_DAYS - 1)), r.endDate, client, sc.domains, sc.appIds],
    sql: `
      SELECT 'Site' AS type, c.name AS client, r.inv_domain AS domain, r.inv_site AS site,
             '' AS app_id, '' AS app_name, r.inv_ad_unit AS ad_unit
        FROM rollup_kpi_daily r
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = $3::uuid AND r.inv_app = ''
         AND (r.inv_domain <> '' OR r.inv_site <> '' OR r.inv_ad_unit <> '')
         AND ($4::text[] IS NULL OR lower(r.inv_domain) = ANY($4::text[]))
       GROUP BY c.name, r.inv_domain, r.inv_site, r.inv_ad_unit
      UNION ALL
      SELECT 'App', c.name, '', '', a.inv_app, COALESCE(n.app_name, ''), ''
        FROM (
          SELECT DISTINCT client_id, inv_app FROM rollup_kpi_daily
           WHERE report_date BETWEEN $1 AND $2 AND client_id = $3::uuid
             AND inv_domain = '' AND inv_site = '' AND inv_ad_unit = '' AND inv_app <> ''
             AND ($5::text[] IS NULL OR lower(inv_app) = ANY($5::text[]))
        ) a
        JOIN gam_clients c ON c.id = a.client_id
        LEFT JOIN (
          SELECT lower(app_id) AS k, MAX(app_name) AS app_name FROM rollup_app_country_daily
           WHERE client_id = $3::uuid GROUP BY lower(app_id)
        ) n ON n.k = lower(a.inv_app)
      ORDER BY 1, 3, 4, 7, 5`,
    row: (x) => [x.type, x.client, x.domain, x.site, x.app_id, x.app_name, x.ad_unit],
  },
  AdMob: {
    tab: 'AdMob',
    kind: 'admob',
    header: ['Date', 'Client', 'Account', 'Earnings', 'Impressions', 'Clicks', 'Ad Requests',
      'Matched Requests', 'CTR', 'eCPM', 'Match Rate', 'Currency'],
    keyCols: 3,
    params: (r, client, sc) => [r.startDate, r.endDate, client, sc.admobIds],
    sql: `
      SELECT r.report_date::text AS d, c.name AS client,
             COALESCE(NULLIF(a.descriptive_name, ''), a.account_id) AS account,
             r.earnings, r.impressions, r.clicks, r.ad_requests, r.matched_requests,
             r.ctr, r.ecpm, r.match_rate, r.currency
        FROM admob_rollup_daily r
        JOIN admob_accounts a ON a.id = r.account_id
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = $3::uuid
         AND ($4::text[] IS NULL OR r.account_id::text = ANY($4::text[]))
       ORDER BY r.report_date, c.name, account`,
    row: (x) => [x.d, x.client, x.account, num(x.earnings), num(x.impressions), num(x.clicks),
      num(x.ad_requests), num(x.matched_requests), num(x.ctr), num(x.ecpm), num(x.match_rate), x.currency],
  },
  AdSense: {
    tab: 'AdSense',
    kind: 'adsense',
    header: ['Date', 'Client', 'Account', 'Earnings', 'Page Views', 'Impressions', 'Clicks',
      'CTR', 'RPM', 'eCPM', 'Currency'],
    keyCols: 3,
    params: (r, client, sc) => [r.startDate, r.endDate, client, sc.adsenseIds],
    sql: `
      SELECT r.report_date::text AS d, c.name AS client,
             COALESCE(NULLIF(a.descriptive_name, ''), a.account_id) AS account,
             r.earnings, r.page_views, r.impressions, r.clicks, r.ctr, r.rpm, r.ecpm, r.currency
        FROM adsense_rollup_daily r
        JOIN adsense_accounts a ON a.id = r.account_id
        JOIN gam_clients c ON c.id = r.client_id
       WHERE r.report_date BETWEEN $1 AND $2 AND r.client_id = $3::uuid
         AND ($4::text[] IS NULL OR r.account_id::text = ANY($4::text[]))
       ORDER BY r.report_date, c.name, account`,
    row: (x) => [x.d, x.client, x.account, num(x.earnings), num(x.page_views), num(x.impressions),
      num(x.clicks), num(x.ctr), num(x.rpm), num(x.ecpm), x.currency],
  },
};

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
    return { scope: { domains: null, appIds: null, admobIds: null, adsenseIds: null }, skips: {} };
  }
  const scope = { domains: [], appIds: [], admobIds: [], adsenseIds: [] };
  const skips = {};
  if (!hasFlag(user, 'canDownloadReports') || user.permissions?.canSeeRevenue === false) {
    const msg = 'Your account is not allowed to download revenue reports';
    ['domains', 'apps', 'network', 'catalog', 'admob', 'adsense'].forEach((k) => { skips[k] = msg; });
    return { scope, skips };
  }
  const inv = getUserInventoryScope(user);
  scope.domains = inv?.domains ? [...inv.domains] : [];
  scope.appIds = inv?.appIds ? [...inv.appIds] : [];
  if (!scope.domains.length) skips.domains = 'No domains assigned to your account';
  if (!scope.appIds.length) skips.apps = 'No apps assigned to your account';
  if (!scope.domains.length && !scope.appIds.length) skips.catalog = 'No domains or apps assigned to your account';
  skips.network = 'Country totals are only available for network-wide (admin) accounts';

  const am = getAdmobScope(user);
  if (!am.accountIds.length) skips.admob = 'No AdMob accounts assigned';
  else if (am.apps.length || am.adUnits.length || am.filters.length) skips.admob = 'AdMob access is limited to specific apps — not exportable yet';
  else scope.admobIds = am.accountIds.map(String);

  const as = getAdsenseScope(user);
  if (!as.accountIds.length) skips.adsense = 'No AdSense accounts assigned';
  else if (as.sites.length || as.filters.length) skips.adsense = 'AdSense access is limited to specific sites — not exportable yet';
  else scope.adsenseIds = as.accountIds.map(String);
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

  // AdMob / AdSense rows belong to the account's hidden publisher workspace, not the GAM network itself.
  let publisherId;
  const publisherClientId = async () => {
    if (publisherId === undefined) {
      const client = await getClientById(clientId);
      publisherId = (await resolvePublisherClient(client))?.id || clientId;
    }
    return publisherId;
  };

  const result = {};
  for (const [name, src] of Object.entries(SOURCES)) {
    if (skips[src.kind]) { result[name] = { skipped: skips[src.kind] }; continue; }
    if (range.startDate > range.endDate) { result[name] = { skipped: 'Date range outside your allowed window' }; continue; }
    try {
      const tenantId = src.kind === 'admob' || src.kind === 'adsense' ? await publisherClientId() : clientId;
      const { rows } = await query(src.sql, src.params(range, tenantId, scope));
      const out = await upsertTab(sheets, spreadsheetId, src, rows.map(src.row));
      result[name] = { fetched: rows.length, ...out };
      logger.info(`Sheets export [${name}] user=${user.username} ${range.startDate}→${range.endDate}: ${rows.length} rows (updated ${out.updated}, appended ${out.appended})`);
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
