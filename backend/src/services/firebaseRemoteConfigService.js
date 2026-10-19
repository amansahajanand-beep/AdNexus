/**
 * Read-only extraction of valid-JSON values from a subdomain's Firebase Remote Config.
 * One or more Google accounts are connected per client (OAuth, refresh tokens stored encrypted in firebase_accounts).
 * Apps are matched to Firebase projects across all of them; hosts keep their dots (finance2.x.com).
 */
const crypto = require('crypto');
const { google } = require('googleapis');
const { query } = require('../db');
const { encryptSecret, decryptSecret } = require('../utils/credentialsCrypto');
const { kvGet, kvSet } = require('../utils/kvCache');
const logger = require('../utils/logger');

const SCOPES = [
  // The consent screen rejects firebase.remoteconfig; cloud-platform covers Remote Config + project listing.
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
];
const CACHE_TTL_MS = (parseInt(process.env.FIREBASE_RC_CACHE_TTL, 10) || 300) * 1000;

function normalizeSite(host) {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

function redirectUri() {
  if (process.env.GOOGLE_FIREBASE_REDIRECT_URI) return String(process.env.GOOGLE_FIREBASE_REDIRECT_URI).trim();
  const gam = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (gam) return gam.replace(/\/auth\/callback\/?$/, '/auth/firebase/callback');
  return `http://localhost:${process.env.PORT || 3001}/auth/firebase/callback`;
}

function getOAuthClient(gamClient) {
  const clientId = process.env.GOOGLE_FIREBASE_CLIENT_ID || gamClient?.googleClientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_FIREBASE_CLIENT_SECRET || gamClient?.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth client ID/secret missing (GOOGLE_FIREBASE_CLIENT_ID/SECRET or GOOGLE_CLIENT_ID/SECRET).');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri());
}

function buildAuthUrl(gamClient, state) {
  return getOAuthClient(gamClient).generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account consent',
    state,
  });
}

/** Callback: exchange code, remember the refresh token under the Google account's email (one row per account). */
async function saveConnectionFromCode(gamClient, code) {
  const oauth = getOAuthClient(gamClient);
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) throw new Error('no_refresh_token');
  // Google lets users untick permissions on the consent screen; without this one nothing below works.
  if (!String(tokens.scope || '').includes('cloud-platform')) throw new Error('missing_permission: tick every requested permission');
  oauth.setCredentials(tokens);
  let email = '';
  try {
    const info = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
    email = String(info.data.email || '').toLowerCase();
  } catch (_) { /* handled below */ }
  if (!email) throw new Error('no_email: could not read the Google account email');
  await query(
    `INSERT INTO firebase_accounts (id, client_id, google_email, refresh_token_enc, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, NOW())
     ON CONFLICT (client_id, google_email)
     DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc, updated_at = NOW()`,
    [crypto.randomUUID(), gamClient.id, email, encryptSecret(tokens.refresh_token)]
  );
}

/** Every connected Google account of the client, each with a ready OAuth client. */
async function authorizedClients(gamClient) {
  const { rows } = await query(
    'SELECT id, google_email, refresh_token_enc FROM firebase_accounts WHERE client_id = $1::uuid ORDER BY created_at, google_email',
    [gamClient.id]
  );
  return rows.map((r) => {
    const oauth = getOAuthClient(gamClient);
    oauth.setCredentials({ refresh_token: decryptSecret(r.refresh_token_enc) });
    return { id: r.id, email: r.google_email, oauth };
  });
}

async function getStatus(clientId) {
  const [accounts, maps] = await Promise.all([
    query('SELECT id, google_email, updated_at FROM firebase_accounts WHERE client_id = $1::uuid ORDER BY created_at, google_email', [clientId]),
    query('SELECT site, project_id FROM firebase_site_projects WHERE client_id = $1::uuid ORDER BY site', [clientId]),
  ]);
  return {
    connected: accounts.rows.length > 0,
    email: accounts.rows[0]?.google_email || '',
    accounts: accounts.rows.map((r) => ({ id: r.id, email: r.google_email, updatedAt: r.updated_at })),
    mappings: maps.rows.map((r) => ({ site: r.site, projectId: r.project_id })),
  };
}

/** Removes one Google account, or all of them when accountId is omitted. */
async function disconnect(clientId, accountId = null) {
  const { rowCount } = accountId
    ? await query('DELETE FROM firebase_accounts WHERE client_id = $1::uuid AND id = $2::uuid', [clientId, accountId])
    : await query('DELETE FROM firebase_accounts WHERE client_id = $1::uuid', [clientId]);
  const left = await query('SELECT 1 FROM firebase_accounts WHERE client_id = $1::uuid LIMIT 1', [clientId]);
  if (!left.rows.length) await query('DELETE FROM firebase_site_projects WHERE client_id = $1::uuid', [clientId]);
  return rowCount > 0;
}

/** Turns Google's terse permission errors into something the user can act on. */
async function friendlyGoogleError(err, oauth) {
  const status = err?.response?.status || err?.code;
  const gErr = err?.response?.data?.error;
  const raw = `${gErr?.status || ''} ${gErr?.message || err?.message || ''}`.trim();
  const text = `${err?.message || ''} ${JSON.stringify(err?.response?.data || '')}`;
  let granted = '';
  if (oauth) {
    try {
      const { token } = await oauth.getAccessToken();
      const info = await oauth.getTokenInfo(token);
      granted = ` Granted scopes: ${(info.scopes || []).map((x) => x.replace('https://www.googleapis.com/auth/', '')).join(', ') || 'none'}.`;
    } catch (_) { /* diagnostics only */ }
  }
  logger.warn(`Firebase Google error (${status}): ${raw}${granted}`);
  const detail = ` [Google: ${raw.slice(0, 160)}]${granted}`;
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(text)) {
    return new Error(`Google access is missing a required permission. Click Reconnect and tick every requested permission.${detail}`);
  }
  if (/has not been used|SERVICE_DISABLED/i.test(text)) {
    return new Error(`A required Google API is disabled. Enable "Firebase Management API" and "Firebase Remote Config API" in the Google Cloud project of your OAuth client.${detail}`);
  }
  if (status === 401 || /invalid_grant/i.test(text)) {
    return new Error(`Google access expired or was revoked. Click Reconnect.${detail}`);
  }
  return new Error(`Google rejected the request.${detail}`);
}

/**
 * Firebase projects every connected Google account can see (deduped by project id, first account wins).
 * Returns { projects: [{projectId, displayName, accountId, accountEmail}], errors: [{email, message}] },
 * or null when no account is connected. A failing account is reported in errors instead of hiding the others.
 */
async function listFirebaseProjects(gamClient) {
  const accounts = await authorizedClients(gamClient);
  if (!accounts.length) return null;
  const errors = [];
  const perAccount = await Promise.all(accounts.map(async (acc) => {
    const found = [];
    let pageToken = '';
    try {
      do {
        let res;
        try {
          res = await acc.oauth.request({
            url: 'https://firebase.googleapis.com/v1beta1/projects',
            params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
          });
        } catch (err) {
          throw await friendlyGoogleError(err, acc.oauth);
        }
        (res.data.results || []).forEach((p) => found.push({
          projectId: p.projectId, displayName: p.displayName || p.projectId, accountId: acc.id, accountEmail: acc.email,
        }));
        pageToken = res.data.nextPageToken || '';
      } while (pageToken);
    } catch (err) {
      errors.push({ email: acc.email, message: err.message });
    }
    return found;
  }));
  // Merge in connection order so a project shared by several accounts always belongs to the oldest connected one.
  const byId = new Map();
  perAccount.flat().forEach((p) => { if (!byId.has(p.projectId)) byId.set(p.projectId, p); });
  const projects = [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { projects, errors };
}

async function mapSiteToProject(clientId, site, projectId) {
  await query(
    `INSERT INTO firebase_site_projects (client_id, site, project_id, updated_at)
     VALUES ($1::uuid, $2, $3, NOW())
     ON CONFLICT (client_id, site)
     DO UPDATE SET project_id = EXCLUDED.project_id, updated_at = NOW()`,
    [clientId, normalizeSite(site), projectId]
  );
}

async function unmapSite(clientId, site) {
  const { rowCount } = await query(
    'DELETE FROM firebase_site_projects WHERE client_id = $1::uuid AND site = $2',
    [clientId, normalizeSite(site)]
  );
  return rowCount > 0;
}

function parseJsonValue(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : undefined;
  } catch (_) {
    return undefined;
  }
}

/** Pure: Remote Config template -> [{key, source, json}] for every parameter value that is a JSON object/array. */
function extractJsonParams(template) {
  const out = [];
  Object.entries(template?.parameters || {}).forEach(([key, p]) => {
    const add = (source, raw) => {
      const json = parseJsonValue(raw);
      if (json !== undefined) out.push({ key, source, json });
    };
    add('default', p?.defaultValue?.value);
    Object.entries(p?.conditionalValues || {}).forEach(([cond, v]) => add(cond, v?.value));
  });
  return out;
}

/** Remote Config JSON params of one Firebase project (cached). Null when no Google account is connected. */
async function fetchProjectConfig(gamClient, projectId, { refresh = false, accountId = null } = {}) {
  const cacheKey = `firebase_rc:${projectId}`;
  if (!refresh) {
    const hit = await kvGet(cacheKey);
    if (hit?.payload && Date.now() - new Date(hit.updatedAt).getTime() < CACHE_TTL_MS) return hit.payload;
  }
  const accounts = await authorizedClients(gamClient);
  if (!accounts.length) return null;
  // The owning account first; others only as a fallback (a project can be shared with several accounts).
  accounts.sort((a, b) => (b.id === accountId) - (a.id === accountId));
  let lastErr = null;
  for (const acc of accounts) {
    try {
      const res = await acc.oauth.request({
        url: `https://firebaseremoteconfig.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/remoteConfig`,
      });
      const payload = {
        projectId,
        etag: res.headers?.etag || null,
        fetchedAt: new Date().toISOString(),
        params: extractJsonParams(res.data),
      };
      await kvSet(cacheKey, payload);
      return payload;
    } catch (err) {
      lastErr = await friendlyGoogleError(err, acc.oauth);
    }
  }
  throw lastErr;
}

/** Returns null when the site has no mapped project (or Google is not connected). */
async function getRemoteConfigJson(gamClient, host, { refresh = false } = {}) {
  const site = normalizeSite(host);
  const { rows } = await query(
    'SELECT project_id FROM firebase_site_projects WHERE client_id = $1::uuid AND site = $2',
    [gamClient.id, site]
  );
  if (!rows[0]) return null;
  const payload = await fetchProjectConfig(gamClient, rows[0].project_id, { refresh });
  return payload && { ...payload, host: site };
}

// ─── App package -> Firebase project -> subdomain ───────────────────────────

const APP_INDEX_TTL_MS = (parseInt(process.env.FIREBASE_APP_INDEX_TTL, 10) || 3600) * 1000;
const normApp = (v) => String(v || '').trim().toLowerCase();

/**
 * package name / bundle id (lowercased) -> Firebase project id, across every project all connected accounts can see.
 * Cached payload: { sig, apps: {pkg: projectId}, projectAccount: {projectId: accountId} }; sig changes when accounts do.
 */
async function getAppProjectIndex(gamClient, { refresh = false } = {}) {
  const cacheKey = 'firebase_app_index';
  const accounts = await authorizedClients(gamClient);
  if (!accounts.length) return null;
  const sig = accounts.map((a) => a.id).sort().join(',');
  if (!refresh) {
    const hit = await kvGet(cacheKey);
    const p = hit?.payload;
    if (p?.apps && p.sig === sig) {
      if (Date.now() - new Date(hit.updatedAt).getTime() < APP_INDEX_TTL_MS) return p;
      // Expired: rebuilding lists every Firebase project (minutes), so answer from the last copy now and refresh
      // it in the background. Waiting here made the Subdomains auto-fill look like it did nothing.
      const flightKey = `${gamClient.id}`;
      if (!indexRefreshes.has(flightKey)) {
        const job = buildAppProjectIndex(gamClient, accounts, sig, cacheKey)
          .catch((err) => logger.warn(`Firebase app index refresh failed: ${err.message}`))
          .finally(() => indexRefreshes.delete(flightKey));
        indexRefreshes.set(flightKey, job);
      }
      return p;
    }
  }
  return buildAppProjectIndex(gamClient, accounts, sig, cacheKey);
}

const indexRefreshes = new Map();

async function buildAppProjectIndex(gamClient, accounts, sig, cacheKey) {
  const listing = await listFirebaseProjects(gamClient);
  if (!listing.projects.length && listing.errors.length) throw new Error(listing.errors.map((e) => `${e.email}: ${e.message}`).join(' | '));
  const oauthOf = new Map(accounts.map((a) => [a.id, a.oauth]));
  const apps = {};
  const projectAccount = {};
  listing.projects.forEach((p) => { projectAccount[p.projectId] = p.accountId; });
  let failures = 0;
  let lastErr = null;
  const listApps = async (project, kind, field) => {
    const oauth = oauthOf.get(project.accountId);
    let pageToken = '';
    do {
      const res = await oauth.request({
        url: `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(project.projectId)}/${kind}`,
        params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      });
      (res.data.apps || []).forEach((a) => {
        const key = normApp(a[field]);
        if (key && !apps[key]) apps[key] = project.projectId;
      });
      pageToken = res.data.nextPageToken || '';
    } while (pageToken);
  };
  const queue = [...listing.projects];
  const worker = async () => {
    while (queue.length) {
      const project = queue.shift();
      try {
        await listApps(project, 'androidApps', 'packageName');
        await listApps(project, 'iosApps', 'bundleId');
      } catch (err) {
        failures += 1;
        lastErr = err;
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  if (listing.projects.length && failures === listing.projects.length) {
    throw await friendlyGoogleError(lastErr, oauthOf.get(listing.projects[0].accountId));
  }
  const payload = { sig, apps, projectAccount };
  if (Object.keys(apps).length) await kvSet(cacheKey, payload);
  return payload;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Every {host, path} found in URLs (or bare hosts) anywhere inside a parsed JSON value; path is e.g. a.b[0]. */
function extractHostEntries(value, path = '', out = []) {
  if (typeof value === 'string') {
    const text = value.trim();
    const add = (h) => out.push({ host: h.toLowerCase().replace(/^www\./, ''), path });
    const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    urls.forEach((u) => {
      try { add(new URL(u).hostname); } catch (_) { /* skip */ }
    });
    if (!urls.length && HOST_RE.test(text)) add(text);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => extractHostEntries(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => extractHostEntries(v, path ? `${path}.${k}` : k, out));
  }
  return out;
}

/** Hostnames only (see extractHostEntries). */
function extractHosts(value, out = new Set()) {
  extractHostEntries(value).forEach((e) => out.add(e.host));
  return out;
}

/** Keys that hold the link an app opens (e.g. Quiz_Link_List), as opposed to media, privacy policy, ip checker... */
const LINK_PATH_RE = /(link|url|domain|host|site)/i;
const QUIZ_LINK_LIST_PATH_RE = /quiz_?link_?list/i;
const NOT_LINK_PATH_RE = /(exclude|privacy|media|icon|image|checker|policy)/i;
const isLinkPath = (path) => {
  const last = String(path).replace(/\[\d+\]/g, '').split('.').pop();
  return LINK_PATH_RE.test(last) && !NOT_LINK_PATH_RE.test(path);
};

/** GAM subdomain hosts of the network (same rule as /roi-sites: at least two dots). */
async function listKnownSubdomains(clientId) {
  const { rows } = await query(
    `SELECT DISTINCT LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www[.]', '', 'i'))) AS host
     FROM dim_site ds
     WHERE ds.client_id = $1::uuid AND ds.id > 0 AND NULLIF(TRIM(ds.name), '') IS NOT NULL`,
    [clientId]
  );
  return new Set(rows.map((r) => r.host).filter((h) => (h.match(/\./g) || []).length >= 2));
}

async function addAppSite(clientId, app, site) {
  await query(
    `INSERT INTO firebase_app_sites (client_id, app_id, site) VALUES ($1::uuid, $2, $3)
     ON CONFLICT DO NOTHING`,
    [clientId, normApp(app), normalizeSite(site)]
  );
}

async function removeAppSite(clientId, app, site) {
  const { rowCount } = await query(
    'DELETE FROM firebase_app_sites WHERE client_id = $1::uuid AND app_id = $2 AND site = $3',
    [clientId, normApp(app), normalizeSite(site)]
  );
  return rowCount > 0;
}

/** Newest appVersionName_<x_y_z> parameter (numeric compare per segment); null when no parameter follows that naming. */
function latestVersionParam(params) {
  const versions = [...new Set(params.map((p) => p.key))]
    .map((key) => ({ key, m: /^appVersionName_(.+)$/i.exec(key) }))
    .filter((v) => v.m)
    .map((v) => ({ key: v.key, parts: v.m[1].split('_').map((n) => parseInt(n, 10) || 0) }));
  if (!versions.length) return null;
  versions.sort((a, b) => {
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
      const d = (b.parts[i] || 0) - (a.parts[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return versions[0].key;
}

/**
 * For each app package: the subdomains users saved manually, plus the subdomains found in the Remote Config JSON of
 * the Firebase project that owns the package. Auto hosts are kept only when they are GAM subdomains of the network.
 */
async function resolveSitesForApps(gamClient, apps, { refresh = false } = {}) {
  const list = [...new Set((apps || []).map(normApp).filter(Boolean))];
  if (!list.length) return { results: [], warning: '' };
  const warnings = new Set();
  const [manualRes, index, known] = await Promise.all([
    query('SELECT app_id, site FROM firebase_app_sites WHERE client_id = $1::uuid AND app_id = ANY($2::text[])', [gamClient.id, list]),
    getAppProjectIndex(gamClient, { refresh }).catch((err) => { warnings.add(err.message); return null; }),
    listKnownSubdomains(gamClient.id),
  ]);
  const projectIds = [...new Set(list.map((a) => index?.apps?.[a]).filter(Boolean))];
  const configs = {};
  await Promise.all(projectIds.map(async (pid) => {
    try {
      configs[pid] = await fetchProjectConfig(gamClient, pid, { refresh, accountId: index?.projectAccount?.[pid] });
    } catch (err) {
      configs[pid] = null;
      warnings.add(`Remote Config of ${pid}: ${err.message}`);
    }
  }));

  const results = list.map((app) => {
    const projectId = index?.apps?.[app] || null;
    const manualSites = manualRes.rows.filter((r) => r.app_id === app).map((r) => r.site);
    // One parameter per app version (appVersionName_1_4...): the newest drives the app; older ones are suggestions.
    const params = configs[projectId]?.params || [];
    const latestKey = latestVersionParam(params);
    // Only the quiz link lists count: Quiz_Link_List and Quiz_Link_List_Exclude, whatever the casing / prefix
    // (Quiz_link_list, Normal_Quiz_Link_List, Exclude_Quiz_Link_List ...). Hosts under any other key (game_url,
    // *_base_url, privacy policy, media ...) are not the app's subdomains.
    const collect = (list) => {
      const found = [];
      list.forEach((p) => {
        extractHostEntries(p.json).forEach((e) => {
          if (!QUIZ_LINK_LIST_PATH_RE.test(e.path)) return;
          found.push({ host: e.host, param: p.key, source: p.source, path: e.path });
        });
      });
      const sources = {};
      found.filter((f) => known.has(f.host)).forEach((f) => {
        if (!sources[f.host]) sources[f.host] = { param: f.param, source: f.source, path: f.path };
      });
      const notInGam = [...new Set(found.filter((f) => !known.has(f.host)).map((f) => f.host))];
      return { sources, notInGam };
    };
    const latest = collect(params.filter((p) => !latestKey || p.key === latestKey));
    const older = latestKey ? collect(params.filter((p) => p.key !== latestKey)) : { sources: {} };
    const autoSites = Object.keys(latest.sources).filter((h) => !manualSites.includes(h));
    // Hosts only older versions use: not added automatically, offered as suggestions.
    const olderSites = Object.keys(older.sources).filter((h) => !latest.sources[h] && !manualSites.includes(h));
    const olderSources = {};
    olderSites.forEach((h) => { olderSources[h] = older.sources[h]; });
    return {
      app, projectId, manualSites, autoSites, sources: latest.sources, latestParam: latestKey,
      olderSites, olderSources, notInGam: latest.notInGam,
    };
  });
  return { results, warning: [...warnings].join(' | ') };
}

module.exports = {
  normalizeSite,
  buildAuthUrl,
  saveConnectionFromCode,
  getStatus,
  disconnect,
  listFirebaseProjects,
  mapSiteToProject,
  unmapSite,
  extractJsonParams,
  extractHosts,
  extractHostEntries,
  getAppProjectIndex,
  isLinkPath,
  latestVersionParam,
  getRemoteConfigJson,
  resolveSitesForApps,
  fetchProjectConfig,
  addAppSite,
  removeAppSite,
};
