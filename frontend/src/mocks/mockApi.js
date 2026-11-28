/**
 * Local-only mock API for frontend UI work. Active ONLY when REACT_APP_MOCK=true and NODE_ENV !== 'production'.
 * Replaces the network layer of the two axios instances; the real login screen and Redux flow are untouched.
 * Unknown endpoints resolve with an empty success so pages render their empty states.
 */

const MOCK_USERNAME = 'dashboard.mediamonetix';
const MOCK_PASSWORD = 'Mdmtx@3563ye';
const CLIENT_ID = '00000000-0000-4000-8000-000000000001';

export const MOCK_USER = {
  id: 'mock-admin-001',
  username: MOCK_USERNAME,
  email: 'dashboard@mediamonetix.com',
  role: 'admin',
  clientId: CLIENT_ID,
  permissions: null,
  isActive: true,
  lastLogin: null,
};

const MOCK_NETWORK = {
  id: CLIENT_ID,
  name: 'Demo Network',
  displayName: 'Demo Network',
  networkCode: '12345678',
  currency: 'USD',
};

const FULL_PERMS = {
  canAccessDashboard: true,
  canAccessReporting: true,
  canAccessDomainUser: true,
  canAccessRoi: false,
  canAccessMyAds: false,
  canLogin: true,
  canGenerateReports: true,
  canDownloadReports: true,
  canUseFilters: true,
  canUseReportBuilder: true,
  canSeeRevenue: true,
  canSeeImpressions: true,
  canSeeCTR: true,
  canSeeECPM: true,
  canSeeProgrammatic: true,
  allowedDomains: [],
  allowedSites: [],
  allowedAppIds: [],
  allowedAdUnits: [],
  dateRestriction: null,
};
const mockDomainUser = (n, username, password, perms) => ({
  id: `mock-user-${n}`,
  username,
  email: `${username}@example.com`,
  role: 'child',
  clientId: CLIENT_ID,
  networkName: MOCK_NETWORK.name,
  networkCode: MOCK_NETWORK.networkCode,
  permissions: { ...FULL_PERMS, ...perms },
  isActive: true,
  createdBy: 'admin',
  createdAt: `2026-0${n}-10T08:00:00.000Z`,
  lastLogin: `2026-11-2${n}T09:30:00.000Z`,
  password, // the admin list shows domain-user passwords in plain text
});

/** Shape of GET /users: an array (the Users table maps over it). */
const MOCK_USERS = [
  { ...MOCK_USER, networkName: MOCK_NETWORK.name, networkCode: MOCK_NETWORK.networkCode, createdAt: '2026-01-05T08:00:00.000Z' },
  mockDomainUser(1, 'financespher.team', 'Fs@4821pq', {
    allowedDomains: ['financespher.com'], allowedSites: ['finance11.financespher.com'], canAccessRoi: true,
  }),
  mockDomainUser(2, 'quizverse.ops', 'Qz@7710mn', { allowedDomains: ['quizverse.com'], canSeeECPM: false }),
  mockDomainUser(3, 'puzzle.apps', 'Pz@2294kd', { allowedAppIds: ['com.adnexus.puzzlequestsaga', 'com.adnexus.blockblastmaster'] }),
  mockDomainUser(4, 'regional.lead', 'Rl@9035xs', { canManageUsers: true, allowedDomains: ['dailynestly.com'], allowedSites: ['news24.dailynestly.com'] }),
];

const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
// JWT-shaped so utils/auth/crossTabAuth can decode { id, sid } from it.
const MOCK_TOKEN = `${b64({ alg: 'none' })}.${b64({ id: MOCK_USER.id, sid: 'mock-session' })}.mock`;

function httpError(config, status, data) {
  const err = new Error(`Request failed with status code ${status}`);
  err.config = config;
  err.response = { status, data, headers: {}, config };
  return err;
}

function route(config) {
  const method = String(config.method || 'get').toLowerCase();
  const path = String(config.url || '').split('?')[0].replace(/^\/?(api\/)?/, '/');
  const hasToken = !!(config.headers && (config.headers.Authorization || config.headers.get?.('Authorization')));

  if (path === '/auth/login' && method === 'post') {
    let body = config.data;
    try { if (typeof body === 'string') body = JSON.parse(body); } catch { body = {}; }
    if (body?.username === MOCK_USERNAME && body?.password === MOCK_PASSWORD) {
      return { token: MOCK_TOKEN, user: MOCK_USER };
    }
    throw httpError(config, 401, { error: 'Invalid username or password.' });
  }
  if (path === '/auth/me' && method === 'get') {
    if (!hasToken) throw httpError(config, 401, { code: 'NOT_AUTHENTICATED', error: 'Not authenticated' });
    return MOCK_USER;
  }
  if (path === '/auth/me' && method === 'put') return MOCK_USER;
  if (path === '/auth/logout') return { ok: true };

  if (path === '/network/info') return { ...MOCK_NETWORK, isMock: false };
  if (path === '/clients/me') return { ...MOCK_NETWORK, networks: [MOCK_NETWORK], activeClientId: CLIENT_ID };
  if (path === '/clients/me/networks' || path === '/clients/me/accessible-networks') {
    return { networks: [MOCK_NETWORK], activeClientId: CLIENT_ID };
  }
  if (path === '/clients/me/active-network') return { activeClientId: CLIENT_ID };

  // Admin → Users list: array of users (admin + sample domain users / one sub-admin).
  if (path === '/users' && method === 'get') return MOCK_USERS;

  // Reporting country filter: array of { id, name }.
  if (path === '/reports/countries') {
    return [
      [1, 'United States'], [2, 'India'], [3, 'United Kingdom'], [4, 'Germany'], [5, 'Brazil'],
      [6, 'Indonesia'], [7, 'Canada'], [8, 'Australia'], [9, 'France'], [10, 'Philippines'],
    ].map(([id, name]) => ({ id, name }));
  }

  // Anything else: empty success.
  return method === 'get' ? {} : { ok: true };
}

export function installMockApi(...instances) {
  const adapter = async (config) => {
    const data = route(config);
    await new Promise((r) => setTimeout(r, 120));
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
  instances.forEach((inst) => { inst.defaults.adapter = adapter; });
  // eslint-disable-next-line no-console
  console.info('[mock] REACT_APP_MOCK=true — API calls are served locally. Login:', MOCK_USERNAME);
}

export const MOCK_ENABLED = process.env.REACT_APP_MOCK === 'true' && process.env.NODE_ENV !== 'production';
