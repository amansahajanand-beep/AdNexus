/**
 * Checks domain-user scopes for AdMob and AdSense: normalization, per-product metrics and report areas,
 * the session view, and the scoped AdSense endpoints against the local database (with synthetic grain rows
 * on a far-past date that are removed afterwards).
 *
 *   npm run test:scope
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';

const assert = require('assert');
const db = require('../src/db');
const { createUser, deleteUser, getUserById } = require('../src/models/userStore');
const { rotateUserSession, stripSessionFields } = require('../src/utils/sessionManager');
const { generateTokens } = require('../src/middleware/auth');
const perms = require('../src/utils/permissions');
const { callRouter } = require('../src/ai/internalCall');
const { upsertAdSenseGrainRows } = require('../src/models/adsenseGrainStore');

const DAY = '2000-01-01';
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const child = (permissions) => ({ role: 'child', permissions });

check('AdSense scope: sites only, known filters only, metrics and reports cleaned', async () => {
  const s = perms.normalizeAdsenseScope({
    accountIds: ['a1', 'a1', ' '],
    sites: ['a1:one.com', 'zzz:other.com'],
    adUnits: ['a1:unit'],
    filters: ['site', 'ad_unit', 'country', 'bogus'],
    metrics: ['revenue', 'nope'],
    reports: ['dashboard', 'download', 'x'],
  });
  assert.deepStrictEqual(s, {
    accountIds: ['a1'], filters: ['site', 'country'], sites: ['a1:one.com'], metrics: ['revenue'], reports: ['dashboard', 'download'],
  });
  const legacy = perms.normalizeAdmobScope({ accountIds: ['a1'], apps: ['a1:x'], adUnits: [], filters: ['app'] });
  assert.ok(!('metrics' in legacy) && !('reports' in legacy), 'older scopes stay unset');
  assert.deepStrictEqual(perms.normalizeAdsenseScope({ accountIds: ['a1'] }).filters, ['site', 'country', 'platform']);
  assert.strictEqual(perms.normalizeAdsenseScope(null), null);
});

check('metrics: a product scope decides for that product; unset falls back to the general flags', async () => {
  const user = child({
    canSeeRevenue: false,
    admobScope: { accountIds: ['a'], metrics: ['revenue', 'ctr'], reports: ['dashboard'] },
    adsenseScope: { accountIds: ['b'] },
  });
  const admob = perms.buildProductVisibility(user, 'admob');
  assert.deepStrictEqual([admob.revenue, admob.impressions, admob.ctr, admob.ecpm, admob.download], [true, false, true, false, false]);
  const adsense = perms.buildProductVisibility(user, 'adsense');
  assert.strictEqual(adsense.revenue, false, 'no metrics set: the general "no revenue" flag still applies');
  assert.strictEqual(adsense.download, true);
  assert.strictEqual(perms.buildProductVisibility({ role: 'admin' }, 'adsense').revenue, true);
});

check('report areas gate the product pages', async () => {
  const user = child({
    admobScope: { accountIds: ['a'], reports: ['dashboard'] },
    adsenseScope: { accountIds: ['b'], reports: ['reporting', 'download'] },
  });
  assert.strictEqual(perms.canAccessPage(user, 'admob-dashboard'), true);
  assert.strictEqual(perms.canAccessPage(user, 'admob-reporting'), false);
  assert.strictEqual(perms.canAccessPage(user, 'adsense-dashboard'), false);
  assert.strictEqual(perms.canAccessPage(user, 'adsense-reporting'), true);
  assert.strictEqual(perms.canAccessPage(child({}), 'adsense-dashboard'), false, 'no AdSense scope, no access');
  assert.strictEqual(perms.buildVisibility(user).pages.adsense, true);
});

check('session view keeps counts, filters, metrics and report areas but no ids', async () => {
  const out = stripSessionFields({
    role: 'child',
    passwordHash: 'x',
    permissions: {
      adsenseScope: { accountIds: ['a', 'b'], sites: ['a:secret.com'], filters: ['site'], metrics: ['revenue'], reports: ['dashboard'] },
      admobScope: { accountIds: ['a'], apps: ['a:app'], filters: ['app'] },
    },
  });
  assert.deepStrictEqual(out.permissions.adsenseScope, { accountCount: 2, filters: ['site'], metrics: ['revenue'], reports: ['dashboard'] });
  assert.deepStrictEqual(out.permissions.admobScope, { accountCount: 1, filters: ['app'] });
  assert.ok(!JSON.stringify(out).includes('secret.com'));
});

async function withScopedUser(adsenseScope, fn) {
  const { rows } = await db.schemaQuery(
    `SELECT a.id AS account_id, a.client_id AS publisher_client, c.publisher_parent_id AS parent
     FROM adsense_accounts a JOIN gam_clients c ON c.id = a.client_id
     WHERE c.publisher_parent_id IS NOT NULL LIMIT 1`
  );
  const { account_id: accountId, publisher_client: publisherClient, parent } = rows[0];
  const id = `user-scopetest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    await upsertAdSenseGrainRows(publisherClient, accountId, [
      { reportDate: DAY, site: 'zz-one.example', country: 'IN', platform: 'Desktop', earnings: 10, pageViews: 100, impressions: 200, clicks: 5 },
      { reportDate: DAY, site: 'zz-one.example', country: 'US', platform: 'Desktop', earnings: 5, pageViews: 50, impressions: 100, clicks: 1 },
      { reportDate: DAY, site: 'zz-two.example', country: 'IN', platform: 'HighEndMobile', earnings: 20, pageViews: 300, impressions: 400, clicks: 8 },
    ]);
    await createUser({
      id,
      username: `scopetest_${id.slice(-8)}`,
      password: 'Test#12345x',
      role: 'child',
      permissions: perms.normalizePermissions('child', { adsenseScope: adsenseScope && adsenseScope(accountId) }),
      clientId: parent,
    });
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    const { accessToken } = generateTokens(user, sid);
    await fn({ authorization: `Bearer ${accessToken}`, accountId });
  } finally {
    await deleteUser(id).catch(() => {});
    await db.schemaQuery(`DELETE FROM adsense_scope_grain_daily WHERE report_date = $1::date`, [DAY]).catch(() => {});
  }
}

const adsenseRouter = () => require('../src/routes/adsense');
const get = (authorization, path, query = {}) => callRouter(adsenseRouter(), { path, query: { startDate: DAY, endDate: DAY, ...query }, authorization });

check('AdSense endpoints: a site-scoped user sees exactly their sites, filters narrow, metrics are hidden', async () => withScopedUser(
  (accountId) => ({ accountIds: [accountId], sites: [`${accountId}:zz-one.example`], metrics: ['revenue'], reports: ['dashboard'] }),
  async ({ authorization }) => {
    const overview = await get(authorization, '/overview');
    assert.strictEqual(overview.status, 200);
    assert.strictEqual(overview.body.totals.earnings, 15, 'only zz-one.example (10 + 5), not zz-two.example');
    assert.strictEqual(overview.body.totals.impressions, undefined, 'impressions are switched off for this user');
    assert.strictEqual(overview.body.totals.page_views, undefined);
    assert.deepStrictEqual(overview.body.kpis.map((k) => k.key), ['earnings']);
    assert.strictEqual(overview.body.visibility.download, false);
    assert.strictEqual(overview.body.account.id, null, 'no publisher ids');

    const sites = await get(authorization, '/breakdowns', { dim: 'site' });
    assert.deepStrictEqual(sites.body.rows.map((r) => r.name), ['zz-one.example']);
    const countries = await get(authorization, '/breakdowns', { dim: 'country' });
    assert.deepStrictEqual(countries.body.rows.map((r) => [r.name, r.earnings]), [['IN', 10], ['US', 5]]);
    const adUnits = await get(authorization, '/breakdowns', { dim: 'ad_unit' });
    assert.deepStrictEqual(adUnits.body.rows, [], 'ad units are not part of an AdSense scope');

    const filtered = await get(authorization, '/overview', { countries: 'IN' });
    assert.strictEqual(filtered.body.totals.earnings, 10);
    const outside = await get(authorization, '/overview', { sites: 'zz-two.example' });
    assert.strictEqual(outside.body.totals.earnings, 0, 'a filter cannot reach outside the assigned sites');

    const options = await get(authorization, '/filters');
    assert.deepStrictEqual(options.body.options.sites.map((o) => o.id), ['zz-one.example']);
    assert.strictEqual((await get(authorization, '/accounts')).status, 403, 'admin-only routes stay closed');
    assert.strictEqual((await get(authorization, '/scope-catalog')).status, 403);
  }
));

check('AdSense endpoints: a whole-account scope sees every site; no scope sees nothing', async () => {
  await withScopedUser((accountId) => ({ accountIds: [accountId] }), async ({ authorization }) => {
    const overview = await get(authorization, '/overview');
    assert.strictEqual(overview.body.totals.earnings, 35);
    assert.ok(overview.body.totals.impressions > 0, 'no metrics set: all metrics shown');
  });
  await withScopedUser(null, async ({ authorization }) => {
    assert.strictEqual((await get(authorization, '/overview')).status, 403);
  });
});

check('admin: scope catalog lists sites with a key per account (last 180 days)', async () => {
  const { grainScopeCatalog } = require('../src/models/adsenseGrainStore');
  const { rows } = await db.schemaQuery('SELECT id, client_id FROM adsense_accounts LIMIT 1');
  const { id: accountId, client_id: clientId } = rows[0];
  const recent = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await upsertAdSenseGrainRows(clientId, accountId, [
    { reportDate: recent, site: 'zz-catalog.example', country: 'IN', platform: 'Desktop', earnings: 1, pageViews: 1, impressions: 1, clicks: 0 },
  ]);
  try {
    const cat = await grainScopeCatalog(clientId, [accountId]);
    assert.deepStrictEqual(
      cat.sites.find((s) => s.name === 'zz-catalog.example'),
      { key: `${accountId}:zz-catalog.example`, accountId, name: 'zz-catalog.example' }
    );
    assert.deepStrictEqual(await grainScopeCatalog(clientId, []), { sites: [] });
  } finally {
    await db.schemaQuery(`DELETE FROM adsense_scope_grain_daily WHERE site = 'zz-catalog.example'`).catch(() => {});
  }
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.fn();
      console.log(`ok   ${c.name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${err.message}`);
    }
  }
  await db.schemaQuery(`DELETE FROM adsense_scope_grain_daily WHERE report_date = $1::date`, [DAY]).catch(() => {});
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
