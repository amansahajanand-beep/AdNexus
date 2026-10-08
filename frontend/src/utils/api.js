import axios from 'axios';
import { getReportTz, setReportTz } from './reportTimezone';
import { TOKEN_KEY } from './auth/authConstants';
import { clearSessionSuperseded, isIntentionalLogout } from './auth/crossTabAuth';
import { getUserFacingMessage, logErrorForDebug } from './auth/userFacingError';
import { clearRecentFilters } from './filters/recentFilters';

export { TOKEN_KEY } from './auth/authConstants';

function readStoredToken() {
  const fromLocal = localStorage.getItem(TOKEN_KEY);
  if (fromLocal) return fromLocal;
  const fromSession = sessionStorage.getItem(TOKEN_KEY);
  if (fromSession) {
    localStorage.setItem(TOKEN_KEY, fromSession);
    sessionStorage.removeItem(TOKEN_KEY);
  }
  return fromSession;
}

export function getToken() {
  return readStoredToken();
}
export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

const API = axios.create({
  baseURL: process.env.REACT_APP_API_URL || '/api',
  timeout: 300000, // 5 min — GAM reports can be slow
  headers: { 'Content-Type': 'application/json' }
});

const FAST_API = axios.create({
  baseURL: process.env.REACT_APP_API_URL || '/api',
  timeout: 300000, // 5 min
  headers: { 'Content-Type': 'application/json' }
});

function attachAuth(config) {
  const url = String(config.url || '');
  // Never send a stale Bearer token on login — it triggers false "Session Ended" handling.
  if (/\/auth\/login(?:\?|$)/.test(url)) return config;
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
}

API.interceptors.request.use(attachAuth);
FAST_API.interceptors.request.use(attachAuth);

/**
 * Timezone the user is viewing in (see utils/reportTimezone.js). Empty = the network timezone. The backend rebuilds
 * days it has hourly data for in this zone and leaves older days as they are.
 */
export { setReportTz, getReportTz };
const TZ_URL = /^\/?(reports\/(dashboard|detailed|domain-user)|roi\/|ai\/)/;
function attachReportTz(config) {
  const tz = getReportTz();
  if (tz && TZ_URL.test(String(config.url || ''))) {
    config.headers['X-Report-Tz'] = tz;
  }
  return config;
}
API.interceptors.request.use(attachReportTz);
FAST_API.interceptors.request.use(attachReportTz);

let handlingAuthFailure = false;

function clearAuthStorage() {
  clearRecentFilters();
  setToken(null);
  clearSessionSuperseded();
}

function dispatchAuthFailure(code) {
  if (handlingAuthFailure) return;
  if (isIntentionalLogout()) return;
  handlingAuthFailure = true;
  clearAuthStorage();
  if (code === 'SESSION_REPLACED') {
    window.dispatchEvent(new CustomEvent('session_replaced', { detail: { code } }));
  } else {
    window.dispatchEvent(new CustomEvent('session_expired', {
      detail: { code: code || 'SESSION_INVALID' },
    }));
  }
  setTimeout(() => { handlingAuthFailure = false; }, 0);
}

function handleApiError(err) {
  const status = err.response?.status;
  const data = err.response?.data || {};
  // Surface 202 queued responses as a specific error type so callers can react.
  if (status === 202) {
    const qerr = new Error(data.message || 'Request queued');
    qerr.status = 202;
    qerr.isQueued = true;
    return Promise.reject(qerr);
  }
  if (status === 401 && err.config?.headers?.Authorization) {
    // App boot /auth/me restore: clear token quietly — do not show "Session Ended" on the login page.
    if (err.config?.silentAuth) {
      clearAuthStorage();
    } else {
      const code = String(data.code || '');
      // Only force logout on explicit session invalidation codes from auth middleware.
      // Do not match free-text (e.g. "token" in unrelated errors) — that caused false logouts
      // when report APIs hung and auth lookups failed under DB pressure.
      if (
        code === 'SESSION_REPLACED'
        || code === 'SESSION_INVALID'
        || code === 'SESSION_EXPIRED'
        || code === 'TOKEN_EXPIRED'
        || code === 'NOT_AUTHENTICATED'
        || code === 'NO_TOKEN'
        || code === 'USER_INACTIVE'
      ) {
        dispatchAuthFailure(code);
      }
    }
  }

  logErrorForDebug(err, 'API');

  let msg = getUserFacingMessage(err);
  if (status === 429 || data.error === 'GAM_RATE_LIMITED') {
    msg = getUserFacingMessage({ ...err, isRateLimited: true, status: 429 });
  } else if (err.code === 'ECONNABORTED') {
    msg = getUserFacingMessage({ ...err, isTimeout: true });
  }

  const error = new Error(msg);
  error.status = status;
  error.technicalMessage = data.error || err.message;
  error.response = err.response;
  error.isTimeout = err.code === 'ECONNABORTED';
  error.isRateLimited = status === 429 || data.error === 'GAM_RATE_LIMITED';
  return Promise.reject(error);
}

API.interceptors.response.use((res) => res.data, handleApiError);
FAST_API.interceptors.response.use((res) => res.data, handleApiError);

// Build a query string from a filter object.
function buildFilterQuery(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, val]) => {
    if (val == null || val === '') return;
    if (Array.isArray(val)) {
      val.forEach(v => { if (v != null && v !== '') params.append(key, v); });
    } else {
      params.append(key, val);
    }
  });
  return params.toString();
}

/** GET when small; POST body when filter list would exceed URL limits (proxy/nginx). */
const MAX_REPORT_GET_QUERY_LEN = 1800;
/** Dashboard must fail fast — empty filters must not wait on live GAM (up to 5 min). */
const DASHBOARD_REQUEST_TIMEOUT_MS = 60000;

function reportRequest(path, filters = {}, axiosConfig = {}) {
  const clientId = axiosConfig.clientId || filters.clientId;
  const { clientId: _dropClientId, ...restConfig } = axiosConfig;
  const filterPayload = { ...(filters || {}) };
  delete filterPayload.clientId;
  // Scope + cache-bust: same date filters must not share a cached response across networks.
  if (clientId) {
    filterPayload._cid = String(clientId).replace(/-/g, '').slice(0, 12);
    filterPayload.clientId = String(clientId);
  }
  const qs = buildFilterQuery(filterPayload);
  const headers = {
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...(restConfig.headers || {}),
  };
  if (clientId) headers['X-Gam-Client-Id'] = String(clientId);
  const noCache = {
    ...restConfig,
    headers,
  };
  if (qs.length <= MAX_REPORT_GET_QUERY_LEN) {
    return API.get(`${path}?${qs}`, noCache);
  }
  return API.post(path, filterPayload, noCache);
}

// ─── Reports ──────────────────────────────────────────────────────────────────
export const reportsAPI = {
  getSummary: (days = 30) =>
    API.get(`/reports/summary?days=${days}`),

  getTrend: (days = 30, metric = 'revenue') =>
    API.get(`/reports/trend?days=${days}&metric=${metric}`),

  getByAdType: () =>
    API.get('/reports/by-ad-type'),

  getTopAdvertisers: () =>
    API.get('/reports/top-advertisers'),

  getDetailed: (filters = {}, axiosConfig = {}) =>
    reportRequest('/reports/detailed', filters, axiosConfig),

  getDashboard: (filters = {}, axiosConfig = {}) =>
    reportRequest('/reports/dashboard', filters, {
      timeout: DASHBOARD_REQUEST_TIMEOUT_MS,
      ...axiosConfig,
    }),

  getDomainUserReport: (filters = {}, axiosConfig = {}) =>
    reportRequest('/reports/domain-user', filters, axiosConfig),

  getDashboardOverview: (filters = {}, axiosConfig = {}) =>
    reportRequest('/reports/dashboard/overview', filters, {
      timeout: DASHBOARD_REQUEST_TIMEOUT_MS,
      ...axiosConfig,
    }),

  getCountries: () => FAST_API.get('/reports/countries'),

  getTimezones: (tz) => FAST_API.get('/reports/timezones', { params: tz ? { tz } : undefined }),

  getFilterCatalog: (clientId) => API.get('/reports/filter-catalog', {
    // Bust browser HTTP cache when the active GAM network changes.
    params: clientId ? { _cid: String(clientId).slice(0, 8) } : undefined,
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...(clientId ? { 'X-Gam-Client-Id': String(clientId) } : {}),
    },
  }),

  /** Merge filter catalogs from multiple GAM networks (unique option lists). */
  getMergedFilterCatalog: async (clientIds = []) => {
    const ids = [...new Set((clientIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return reportsAPI.getFilterCatalog();
    if (ids.length === 1) return reportsAPI.getFilterCatalog(ids[0]);
    const results = (await Promise.all(
      ids.map((id) => reportsAPI.getFilterCatalog(id).catch(() => null))
    )).filter(Boolean);
    if (!results.length) return {};

    const uniqStrings = (lists) => {
      const seen = new Set();
      const out = [];
      for (const list of lists) {
        for (const item of (Array.isArray(list) ? list : [])) {
          const s = String(item || '').trim();
          if (!s) continue;
          const k = s.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(item);
        }
      }
      return out;
    };

    const mergeMapOfLists = (maps) => {
      const out = {};
      for (const map of maps) {
        if (!map || typeof map !== 'object') continue;
        for (const [key, vals] of Object.entries(map)) {
          if (!out[key]) out[key] = [];
          const seen = new Set(out[key].map((v) => String(v).toLowerCase()));
          for (const v of (Array.isArray(vals) ? vals : [])) {
            const k = String(v || '').toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out[key].push(v);
          }
        }
      }
      return out;
    };

    const mergeRows = (rowLists) => {
      const seen = new Set();
      const out = [];
      for (const rows of rowLists) {
        for (const row of (Array.isArray(rows) ? rows : [])) {
          const key = [
            row?.domain || row?.domainName || '',
            row?.site || row?.siteName || '',
            row?.adUnit || row?.adUnitName || '',
            row?.appId || row?.appPackage || '',
          ].join('|').toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(row);
        }
      }
      return out;
    };

    return {
      ...results[0],
      domainRoots: uniqStrings(results.map((r) => r.domainRoots)),
      siteHosts: uniqStrings(results.map((r) => r.siteHosts)),
      appPackages: uniqStrings(results.map((r) => r.appPackages)),
      domains: uniqStrings(results.map((r) => r.domains)),
      sites: uniqStrings(results.map((r) => r.sites)),
      countries: uniqStrings(results.map((r) => r.countries)),
      devices: uniqStrings(results.map((r) => r.devices)),
      apps: uniqStrings(results.map((r) => r.apps)),
      adUnits: uniqStrings(results.map((r) => r.adUnits)),
      sitesByDomain: mergeMapOfLists(results.map((r) => r.sitesByDomain)),
      adUnitsByHost: mergeMapOfLists(results.map((r) => r.adUnitsByHost)),
      rows: mergeRows(results.map((r) => r.rows)),
      noDomainsAssigned: results.every((r) => r.noDomainsAssigned === true),
      mergedFrom: ids.length,
    };
  },

  getProgrammatic: (filters = {}, axiosConfig = {}) =>
    reportRequest('/reports/programmatic', filters, axiosConfig),

  // On-demand range endpoint (may return 202 when queued)
  getReportRange: (filters = {}, axiosConfig = {}) =>
    reportRequest('/reports/range', filters, axiosConfig),
};

// ─── Orders ───────────────────────────────────────────────────────────────────
export const ordersAPI = {
  getAll: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return API.get(`/orders?${q}`);
  },
  getById: (id) => API.get(`/orders/${id}`),
};

// ─── Network ──────────────────────────────────────────────────────────────────
export const networkAPI = {
  getInfo: (clientId) => API.get('/network/info', {
    params: clientId ? { _cid: String(clientId).replace(/-/g, '').slice(0, 12), clientId: String(clientId) } : undefined,
    headers: clientId ? { 'X-Gam-Client-Id': String(clientId) } : undefined,
  }),
};

// ─── Inventory ────────────────────────────────────────────────────────────────
export const inventoryAPI = {
  getAdUnits: () => API.get('/inventory/ad-units'),
};

// ─── GAM OAuth status (server-to-Google) ───────────────────────────────────────
export const authAPI = {
  getStatus: () => axios.get('/auth/status').then(r => r.data),
  login: () => window.location.href = '/auth/login',
};

// ─── Dashboard user session ─────────────────────────────────────────────────────
export const sessionAPI = {
  login: (username, password) => FAST_API.post('/auth/login', { username, password }),
  logout: () => FAST_API.post('/auth/logout'),
  me: (opts = {}) => FAST_API.get('/auth/me', opts),
  updateProfile: (payload) => FAST_API.put('/auth/me', payload),
};

// ─── User management (admin) ────────────────────────────────────────────────────
export const clientsAPI = {
  register: (payload) => FAST_API.post('/onboard/register', payload),
  onboard: (payload) => FAST_API.post('/onboard', payload),
  onboardOauthStart: (payload) => FAST_API.post('/onboard/oauth-start', payload),
  onboardOauthPending: (id) => FAST_API.get(`/onboard/oauth/pending/${id}`),
  onboardOauthSelect: (payload) => FAST_API.post('/onboard/oauth/select', payload),
  me: () => FAST_API.get('/clients/me'),
  updateMe: (payload) => FAST_API.put('/clients/me', payload),
  networks: () => FAST_API.get('/clients/me/networks'),
  accessibleNetworks: () => FAST_API.get('/clients/me/accessible-networks'),
  setActiveNetwork: (clientId) => FAST_API.post('/clients/me/active-network', { clientId }),
  oauthUrl: () => FAST_API.get('/clients/me/oauth-url'),
  oauthPending: (id) => FAST_API.get(`/clients/oauth/pending/${id}`),
  oauthSelect: (id, payload) => FAST_API.post(`/clients/oauth/pending/${id}/select`, payload),
};

/** Optional per-call network scope (AdMob ROI uses the account's root network for Ads). */
function scopedTo(clientId) {
  return clientId ? { headers: { 'X-Gam-Client-Id': String(clientId) } } : undefined;
}

/** Google Ads account management, optionally pinned to one tenant (e.g. the AdMob workspace). */
function makeAdsAccountsAPI(scopeId = null) {
  const sc = (clientId) => scopedTo(clientId || scopeId);
  return {
    listAccounts: () => FAST_API.get('/ads/accounts', sc()),
    syncHealth: (clientId) => FAST_API.get('/ads/sync-health', sc(clientId)),
    mccOauthUrl: (payload, clientId) => FAST_API.post('/ads/accounts/mcc/oauth-url', payload || {}, sc(clientId)),
    oauthPending: (id, clientId) => FAST_API.get(`/ads/oauth/pending/${id}`, sc(clientId)),
    oauthSelect: (id, payload, clientId) => FAST_API.post(`/ads/oauth/pending/${id}/select`, payload, sc(clientId)),
    logins: (clientId) => FAST_API.get('/ads/logins', sc(clientId)),
    useLogin: (payload, clientId) => FAST_API.post('/ads/logins/use', payload, sc(clientId)),
    createMcc: (payload) => FAST_API.post('/ads/accounts/mcc', payload, sc()),
    createIndividual: (payload) => FAST_API.post('/ads/accounts/individual', payload, sc()),
    accountOauthUrl: (id, params, clientId) => FAST_API.get(`/ads/accounts/${id}/oauth-url`, { params, ...sc(clientId) }),
    updateAccount: (id, payload) => FAST_API.patch(`/ads/accounts/${id}`, payload, sc()),
    deleteAccount: (id) => FAST_API.delete(`/ads/accounts/${id}`, sc()),
    deleteAllAccounts: () => FAST_API.delete('/ads/accounts', sc()),
    refreshChildren: (id) => FAST_API.post(`/ads/accounts/${id}/refresh-children`, undefined, sc()),
    syncAll: (payload, clientId) => FAST_API.post('/ads/sync', payload || {}, sc(clientId)),
    syncAccount: (id, payload) => FAST_API.post(`/ads/accounts/${id}/sync`, payload || {}, sc()),
  };
}

export function adsAPIFor(clientId) {
  return clientId ? makeAdsAccountsAPI(clientId) : adsAPI;
}

export const adsAPI = {
  ...makeAdsAccountsAPI(),
  listCampaigns: (id) => FAST_API.get(`/ads/accounts/${id}/campaigns`),
  listRoiCampaigns: (params) => FAST_API.get('/ads/roi-campaigns', { params }),
  listRoiAccounts: (params) => FAST_API.get('/ads/roi-accounts', { params }),
  listRoiSites: (params, clientId) => FAST_API.get('/ads/roi-sites', {
    params,
    ...(clientId ? { headers: { 'X-Gam-Client-Id': String(clientId) } } : {}),
  }),
  listRoiRelatedTargets: (params) => FAST_API.get('/ads/roi-related-targets', { params }),
  listRoiCountries: (params) => FAST_API.get('/ads/roi-countries', { params }),
  listCampaignMaps: () => FAST_API.get('/ads/campaign-maps'),
  saveCampaignMap: (payload) => FAST_API.put('/ads/campaign-maps', payload),
  saveCampaignMapsBulk: (payload) => FAST_API.put('/ads/campaign-maps/bulk', payload),
  deleteCampaignMap: (id) => FAST_API.delete(`/ads/campaign-maps/${id}`),
  listExpenses: (params) => FAST_API.get('/ads/expenses', { params }),
  createExpense: (payload) => FAST_API.post('/ads/expenses', payload),
  deleteExpense: (id) => FAST_API.delete(`/ads/expenses/${id}`),
  // Domain-user My Google Ads
  myListAccounts: () => FAST_API.get('/ads/my/accounts'),
  myOauthUrl: () => FAST_API.post('/ads/my/oauth-url'),
  myOauthPending: (id) => FAST_API.get(`/ads/my/oauth/pending/${id}`),
  myOauthSelect: (id, payload) => FAST_API.post(`/ads/my/oauth/pending/${id}/select`, payload),
  myAccountOauthUrl: (id) => FAST_API.get(`/ads/my/accounts/${id}/oauth-url`),
  myDisconnectAccount: (id) => FAST_API.post(`/ads/my/accounts/${id}/disconnect`),
  mySync: (payload) => FAST_API.post('/ads/my/sync', payload || {}),
};

export const admobAPI = {
  health: () => FAST_API.get('/admob/health'),
  listAccounts: () => FAST_API.get('/admob/accounts'),
  workspace: () => FAST_API.get('/admob/workspace'),
  scopeCatalog: () => FAST_API.get('/admob/scope-catalog'),
  oauthUrl: () => FAST_API.post('/admob/accounts/oauth-url'),
  accountOauthUrl: (id) => FAST_API.get(`/admob/accounts/${id}/oauth-url`),
  oauthPending: (id) => FAST_API.get(`/admob/oauth/pending/${id}`),
  oauthSelect: (id, payload) => FAST_API.post(`/admob/oauth/pending/${id}/select`, payload),
  updateAccount: (id, payload) => FAST_API.patch(`/admob/accounts/${id}`, payload),
  deleteAccount: (id) => FAST_API.delete(`/admob/accounts/${id}`),
  syncAll: (payload) => FAST_API.post('/admob/sync', payload || {}),
  syncAccount: (id, payload) => FAST_API.post(`/admob/accounts/${id}/sync`, payload || {}),
  kpis: (params) => FAST_API.get('/admob/kpis', { params }),
  trend: (params) => FAST_API.get('/admob/trend', { params }),
  overview: (params) => FAST_API.get('/admob/overview', { params }),
  filters: (params) => FAST_API.get('/admob/filters', { params }),
  breakdowns: (params) => FAST_API.get('/admob/breakdowns', { params }),
  table: (params) => FAST_API.get('/admob/table', { params }),
  freshness: (params) => FAST_API.get('/admob/freshness', { params }),
  roi: (params) => FAST_API.get('/admob/roi', { params }),
  roiAdsAccounts: (params) => FAST_API.get('/admob/roi/ads-accounts', { params }),
  saveRoiAdsAccounts: (payload, params) => FAST_API.put('/admob/roi/ads-accounts', payload, { params }),
};

export const adsenseAPI = {
  health: () => FAST_API.get('/adsense/health'),
  listAccounts: () => FAST_API.get('/adsense/accounts'),
  workspace: () => FAST_API.get('/adsense/workspace'),
  scopeCatalog: () => FAST_API.get('/adsense/scope-catalog'),
  roi: (params) => FAST_API.get('/adsense/roi', { params }),
  roiAdsAccounts: (params) => FAST_API.get('/adsense/roi/ads-accounts', { params }),
  saveRoiAdsAccounts: (payload, params) => FAST_API.put('/adsense/roi/ads-accounts', payload, { params }),
  oauthUrl: () => FAST_API.post('/adsense/accounts/oauth-url'),
  accountOauthUrl: (id) => FAST_API.get(`/adsense/accounts/${id}/oauth-url`),
  oauthPending: (id) => FAST_API.get(`/adsense/oauth/pending/${id}`),
  oauthSelect: (id, payload) => FAST_API.post(`/adsense/oauth/pending/${id}/select`, payload),
  updateAccount: (id, payload) => FAST_API.patch(`/adsense/accounts/${id}`, payload),
  deleteAccount: (id) => FAST_API.delete(`/adsense/accounts/${id}`),
  syncAll: (payload) => FAST_API.post('/adsense/sync', payload || {}),
  syncAccount: (id, payload) => FAST_API.post(`/adsense/accounts/${id}/sync`, payload || {}),
  kpis: (params) => FAST_API.get('/adsense/kpis', { params }),
  trend: (params) => FAST_API.get('/adsense/trend', { params }),
  overview: (params) => FAST_API.get('/adsense/overview', { params }),
  filters: (params) => FAST_API.get('/adsense/filters', { params }),
  breakdowns: (params) => FAST_API.get('/adsense/breakdowns', { params }),
  table: (params) => FAST_API.get('/adsense/table', { params }),
  freshness: () => FAST_API.get('/adsense/freshness'),
};

export const roiAPI = {
  summary: (params, config) => FAST_API.get('/roi/summary', { params, ...config }),
};

/** Saved report presets (server copy; localStorage stays the fast local cache). */
export const presetsAPI = {
  getAll: () => FAST_API.get('/presets'),
  // 409 is a normal outcome (another device saved first): the body carries the server copy.
  savePage: (page, items, baseVersion) => FAST_API.put(
    `/presets/${encodeURIComponent(page)}`,
    { items, baseVersion },
    { validateStatus: (status) => (status >= 200 && status < 300) || status === 409 }
  ),
};

/** Campaign → site/app mapping: AI suggestions plus the saved maps (optionally pinned to a workspace). */
export const mappingAPI = {
  suggest: (payload, clientId) => FAST_API.post('/ai/mapping-suggestions', payload, scopedTo(clientId)),
  listMaps: (clientId) => FAST_API.get('/ads/campaign-maps', scopedTo(clientId)),
  saveBulk: (payload, clientId) => FAST_API.put('/ads/campaign-maps/bulk', payload, scopedTo(clientId)),
  deleteMap: (id, clientId) => FAST_API.delete(`/ads/campaign-maps/${id}`, scopedTo(clientId)),
};

/** AI features: availability and feedback (the analysis itself streams, see utils/ai/presetAnalysis). */
export const aiAPI = {
  status: () => FAST_API.get('/ai/status'),
  feedback: (payload) => FAST_API.post('/ai/feedback', payload),
  admin: () => FAST_API.get('/ai/admin'),
  tokenSeries: (by) => FAST_API.get('/ai/token-series', { params: { by } }),
  setEnabled: (enabled) => FAST_API.put('/ai/settings', { enabled }),
  ping: () => FAST_API.post('/ai/ping', {}),
  alerts: () => FAST_API.get('/ai/alerts'),
  scanAlerts: () => FAST_API.post('/ai/alerts/scan', {}),
  dismissAlert: (id) => FAST_API.post(`/ai/alerts/${id}/dismiss`, {}),
  reports: () => FAST_API.get('/ai/reports'),
  report: (id) => FAST_API.get(`/ai/reports/${id}`),
  generateReport: (force = false) => FAST_API.post('/ai/reports/generate', { force }),
  setForecastTarget: (product, amount) => FAST_API.put('/ai/forecast-target', { product, amount }),
};

export const usersAPI = {
  getAll: () => FAST_API.get('/users'),
  getInventoryPicker: (clientId) => FAST_API.get('/users/inventory-picker', {
    params: clientId ? { _cid: String(clientId).slice(0, 8) } : undefined,
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...(clientId ? { 'X-Gam-Client-Id': String(clientId) } : {}),
    },
  }),
  /** Merge inventory pickers for selected networks (domain-user scope UI). */
  getMergedInventoryPicker: async (clientIds = []) => {
    const ids = [...new Set((clientIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return usersAPI.getInventoryPicker();
    if (ids.length === 1) return usersAPI.getInventoryPicker(ids[0]);
    const results = (await Promise.all(
      ids.map((id) => usersAPI.getInventoryPicker(id).catch(() => null))
    )).filter(Boolean);
    if (!results.length) return {};
    const uniq = (lists) => {
      const seen = new Set();
      const out = [];
      for (const list of lists) {
        for (const item of (Array.isArray(list) ? list : [])) {
          const s = String(item?.id || item?.label || item || '').trim();
          if (!s) continue;
          const k = s.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(item);
        }
      }
      return out;
    };
    const uniqStrings = (lists) => {
      const seen = new Set();
      const out = [];
      for (const list of lists) {
        for (const item of (Array.isArray(list) ? list : [])) {
          const s = String(item || '').trim();
          if (!s) continue;
          const k = s.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(item);
        }
      }
      return out;
    };
    return {
      ...results[0],
      siteHosts: uniqStrings(results.map((r) => r.siteHosts)),
      appIds: uniqStrings(results.map((r) => r.appIds)),
      domainRoots: uniqStrings(results.map((r) => r.domainRoots)),
      domains: uniq(results.map((r) => r.domains)),
    };
  },
  create: (payload) => FAST_API.post('/users', payload),
  update: (id, payload) => FAST_API.put(`/users/${id}`, payload),
  updatePermissions: (id, payload) => FAST_API.put(`/users/${id}/permissions`, payload),
  remove: (id) => FAST_API.delete(`/users/${id}`),
};

// ─── Domain / channel catalogue ─────────────────────────────────────────────────
export const domainsAPI = {
  getAll: () => FAST_API.get('/domains'),
};

export default API;
