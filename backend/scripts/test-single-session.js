/**
 * Manual integration test for single active session.
 * Usage: node scripts/test-single-session.js [baseUrl] [username] [password]
 * Default: http://localhost:3099 dashboard.mediamonetix <password from env or prompt>
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');

const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 3099}`;
const USER = process.argv[3] || 'dashboard.mediamonetix';
const PASS = process.argv[4] || process.env.TEST_ADMIN_PASSWORD || 'Mdmtx@3563ye';

function auth(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function login() {
  const { data } = await axios.post(`${BASE}/api/auth/login`, { username: USER, password: PASS });
  return data.token;
}

async function me(token) {
  const { data, status } = await axios.get(`${BASE}/api/auth/me`, auth(token));
  return { status, data };
}

async function logout(token) {
  const { status } = await axios.post(`${BASE}/api/auth/logout`, {}, auth(token));
  return status;
}

function decodeSid(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return payload.sid;
}

async function assert(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  OK: ${label}`);
}

async function run() {
  console.log(`Testing single-session at ${BASE} as ${USER}\n`);

  console.log('1) Login → token A');
  const tokenA = await login();
  await assert(!!tokenA, 'received token A');
  const sidA = decodeSid(tokenA);
  await assert(!!sidA, 'token A has sid');

  console.log('2) /me with token A');
  const meA = await me(tokenA);
  await assert(meA.status === 200, '/me works with token A');

  console.log('3) Second login (same user) → token B, invalidates A');
  const tokenB = await login();
  const sidB = decodeSid(tokenB);
  await assert(sidB !== sidA, 'token B has new sid');

  console.log('4) /me with old token A → 401 SESSION_REPLACED');
  try {
    await me(tokenA);
    throw new Error('expected 401 for stale token A');
  } catch (e) {
    const status = e.response?.status;
    const code = e.response?.data?.code;
    await assert(status === 401 && code === 'SESSION_REPLACED', 'stale token returns SESSION_REPLACED');
  }

  console.log('5) /me with token B still works');
  const meB = await me(tokenB);
  await assert(meB.status === 200, '/me works with token B');

  console.log('6) Logout clears server session');
  const logoutStatus = await logout(tokenB);
  await assert(logoutStatus === 200, 'logout succeeds');

  console.log('7) /me after logout → 401');
  try {
    await me(tokenB);
    throw new Error('expected 401 after logout');
  } catch (e) {
    await assert(e.response?.status === 401, 'token invalid after logout');
  }

  console.log('8) Login again after logout');
  const tokenC = await login();
  await assert(!!tokenC, 'login after logout works');

  console.log('\nAll single-session checks passed.');
}

run().catch((err) => {
  console.error('\nTest failed:', err.message);
  if (err.response?.data) console.error(err.response.data);
  process.exit(1);
});
