import axios from 'axios';
import { TOKEN_KEY } from './authConstants';
import { clearSessionSuperseded, isIntentionalLogout } from './crossTabAuth';
import { getUserFacingMessage, logErrorForDebug } from './userFacingError';
import { clearRecentFilters } from './recentFilters';

export { TOKEN_KEY } from './authConstants';

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
      // Only force logout on explicit session invalidation — not every opaque 401.
      if (
        code === 'SESSION_REPLACED'
        || code === 'SESSION_INVALID'
        || code === 'SESSION_EXPIRED'
        || code === 'TOKEN_EXPIRED'
        || code === 'NOT_AUTHENTICATED'
        || code === 'NO_TOKEN'
        || code === 'USER_INACTIVE'
        || /session|token|expired|unauthorized|not authenticated/i.test(String(data.error || data.message || ''))
      ) {
        dispatchAuthFailure(code || data.code);
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

function reportRequest(path, filters = {}) {
  const qs = buildFilterQuery(filters);
  const noCache = { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } };
  if (qs.length <= MAX_REPORT_GET_QUERY_LEN) {
    return API.get(`${path}?${qs}`, noCache);
  }
  return API.post(path, filters, noCache);
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

  getDetailed: (filters = {}) =>
    reportRequest('/reports/detailed', filters),

  getDashboard: (filters = {}) =>
    reportRequest('/reports/dashboard', filters),

  getDomainUserReport: (filters = {}) =>
    reportRequest('/reports/domain-user', filters),

  getDashboardOverview: (filters = {}) =>
    reportRequest('/reports/dashboard/overview', filters),

  getCountries: () => FAST_API.get('/reports/countries'),

  getFilterCatalog: () => API.get('/reports/filter-catalog'),

  getProgrammatic: (filters = {}) =>
    reportRequest('/reports/programmatic', filters),

  // On-demand range endpoint (may return 202 when queued)
  getReportRange: (filters = {}) =>
    reportRequest('/reports/range', filters),
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
  getInfo: () => API.get('/network/info'),
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
  onboard: (payload) => FAST_API.post('/onboard', payload),
  me: () => FAST_API.get('/clients/me'),
  updateMe: (payload) => FAST_API.put('/clients/me', payload),
  oauthUrl: () => FAST_API.get('/clients/me/oauth-url'),
};

export const adsAPI = {
  listAccounts: () => FAST_API.get('/ads/accounts'),
  mccOauthUrl: () => FAST_API.post('/ads/accounts/mcc/oauth-url'),
  createMcc: (payload) => FAST_API.post('/ads/accounts/mcc', payload),
  createIndividual: (payload) => FAST_API.post('/ads/accounts/individual', payload),
  accountOauthUrl: (id) => FAST_API.get(`/ads/accounts/${id}/oauth-url`),
  updateAccount: (id, payload) => FAST_API.patch(`/ads/accounts/${id}`, payload),
  deleteAccount: (id) => FAST_API.delete(`/ads/accounts/${id}`),
  refreshChildren: (id) => FAST_API.post(`/ads/accounts/${id}/refresh-children`),
  listCampaigns: (id) => FAST_API.get(`/ads/accounts/${id}/campaigns`),
  listCampaignMaps: () => FAST_API.get('/ads/campaign-maps'),
  saveCampaignMap: (payload) => FAST_API.put('/ads/campaign-maps', payload),
  deleteCampaignMap: (id) => FAST_API.delete(`/ads/campaign-maps/${id}`),
  syncAll: (payload) => FAST_API.post('/ads/sync', payload || {}),
  syncAccount: (id, payload) => FAST_API.post(`/ads/accounts/${id}/sync`, payload || {}),
  listExpenses: (params) => FAST_API.get('/ads/expenses', { params }),
  createExpense: (payload) => FAST_API.post('/ads/expenses', payload),
  deleteExpense: (id) => FAST_API.delete(`/ads/expenses/${id}`),
};

export const roiAPI = {
  summary: (params) => FAST_API.get('/roi/summary', { params }),
};

export const usersAPI = {
  getAll: () => FAST_API.get('/users'),
  getInventoryPicker: () => FAST_API.get('/users/inventory-picker'),
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
