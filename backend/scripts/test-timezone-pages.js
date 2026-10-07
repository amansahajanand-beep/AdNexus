/**
 * End-to-end checks of the timezone view on the real endpoints (Dashboard, Reporting, Domain User page) for an admin
 * and for a domain user with assigned inventory, against the local database. Totals are compared with an independent
 * calculation over the same stored hours.
 *
 *   node scripts/test-timezone-pages.js
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';

const assert = require('assert');
const db = require('../src/db');
const { createUser, deleteUser, getUserById } = require('../src/models/userStore');
const { rotateUserSession } = require('../src/utils/sessionManager');
const { generateTokens } = require('../src/middleware/auth');
const { normalizePermissions } = require('../src/utils/permissions');
const { callRouter } = require('../src/ai/internalCall');
const hv = require('../src/services/hourlyView');
const { getNetworkTz } = require('../src/services/networkTimezone');
const { getClientById } = require('../src/models/clientStore');
const { shiftYMD, ymdInTZ } = require('../src/utils/datetime');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const TZ = 'Asia/Kolkata';
const near = (a, b, msg, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

async function setup() {
  const { rows } = await db.schemaQuery(`SELECT client_id FROM rollup_hourly WHERE kind = 'inventory' GROUP BY client_id ORDER BY COUNT(*) DESC LIMIT 1`);
  const clientId = rows[0]?.client_id;
  if (!clientId) return null;
  const client = await getClientById(clientId);
  const srcTz = await getNetworkTz(client);
  const cov = await hv.coverage(clientId, TZ, ymdInTZ(new Date(), TZ), srcTz);
  if (!cov) return null;
  // five complete local days inside the covered range
  const end = cov.partialDay === cov.through ? shiftYMD(cov.through, -1) : cov.through;
  const start = shiftYMD(end, -4);
  // the biggest sites in that window become a domain user's assignment
  // "(unknown)" and "—" are placeholders, not sites a user can be assigned
  const real = await hv.hourlyRows({ clientId, startDate: start, endDate: end, tz: TZ, srcTz, kind: 'inventory', perDay: false, limit: 12 });
  const sites = real.map((r) => r.siteName).filter((s) => s && /^[a-z0-9]/i.test(s)).slice(0, 3);
  return { clientId, srcTz, start, end, sites };
}

/** Revenue of the given sites over the local days, from the stored hours (each hour split into two halves). */
async function expectedSites(world, sites, { domains = [] } = {}) {
  const { rows } = await db.schemaQuery(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS day, hour, LOWER(dim_a) AS dim_a, LOWER(dim_b) AS dim_b, revenue::float8 AS revenue, impressions::float8 AS impressions
     FROM rollup_hourly WHERE client_id = $1::uuid AND kind = 'inventory' AND report_date BETWEEN $2::date AND $3::date`,
    [world.clientId, shiftYMD(world.start, -3), shiftYMD(world.end, 3)]
  );
  const want = new Set(sites.map((s) => s.toLowerCase()));
  const dom = new Set(domains.map((s) => s.toLowerCase()));
  let revenue = 0;
  let impressions = 0;
  for (const r of rows) {
    const root = (r.dim_b.match(/[^.]+\.[^.]+$/) || [])[0] || r.dim_a;
    if (!want.has(r.dim_b) && !dom.has(root)) continue;
    const inst = hv.wallToInstant(r.day, Number(r.hour), world.srcTz);
    for (const off of [0, 30 * 60000]) {
      const ld = ymdInTZ(new Date(inst + off), TZ);
      if (ld >= world.start && ld <= world.end) { revenue += r.revenue / 2; impressions += r.impressions / 2; }
    }
  }
  return { revenue, impressions };
}

async function withUsers(world, fn) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const made = [];
  const make = async (role, perms) => {
    const id = `user-aitest-${stamp}-${made.length}`;
    await createUser({
      id,
      username: `aitest_${id.slice(-9)}`,
      password: 'Test#12345x',
      role,
      permissions: role === 'admin' ? {} : normalizePermissions('child', { allowedClientIds: [world.clientId], ...perms }),
      clientId: world.clientId,
    });
    made.push(id);
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    return { user, authorization: `Bearer ${generateTokens(user, sid).accessToken}` };
  };
  try {
    await fn(make);
  } finally {
    for (const id of made) await deleteUser(id).catch(() => {});
  }
}

const reports = () => require('../src/routes/reports');
const call = (authorization, path, query) => callRouter(reports(), {
  path, query, authorization, headers: { 'x-report-tz': TZ }, timeoutMs: 90000,
}).then((r) => { assert.strictEqual(r.status, 200, `${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; });

let world;

check('admin Dashboard overview: totals are the regrouped India days', async () => {
  await withUsers(world, async (make) => {
    const { authorization } = await make('admin');
    const body = await call(authorization, '/dashboard/overview', { startDate: world.start, endDate: world.end });
    assert.strictEqual(body.timezone?.applied, true, JSON.stringify(body.timezone));
    assert.strictEqual(body.timezone.tz, TZ);
    const view = await hv.buildHourlyView({ clientId: world.clientId, startDate: world.start, endDate: world.end, tz: TZ, srcTz: world.srcTz });
    near(body.summary.revenue, view.trend.reduce((a, d) => a + d.earning, 0), 'overview revenue', 0.05);
  });
});

check('admin Reporting: date x domain x site rows add up to the regrouped site revenue', async () => {
  await withUsers(world, async (make) => {
    const { authorization } = await make('admin');
    const body = await call(authorization, '/detailed', {
      startDate: world.start, endDate: world.end, reportDimensions: 'date,domain,site_name', allRows: 'true',
      reportMetrics: 'total_line_item_level_cpm_and_cpc_revenue,total_line_item_level_impressions',
    });
    assert.strictEqual(body.timezone?.applied, true, JSON.stringify(body.timezone));
    const rows = body.rows || [];
    assert.ok(rows.length > 0 && rows.every((r) => r.date >= world.start && r.date <= world.end));
    const got = rows.reduce((a, r) => a + r.revenue, 0);
    const all = await hv.hourlyTrend({ clientId: world.clientId, startDate: world.start, endDate: world.end, tz: TZ, srcTz: world.srcTz, kind: 'inventory' });
    near(got, all.reduce((a, d) => a + d.earning, 0), 'reporting revenue vs inventory hours', Math.max(5, got * 0.002));
    near(body.summary.totalRevenue, got, 'summary equals the rows', Math.max(5, got * 0.002));
  });
});

check('admin Reporting by date x hour: one row per local hour, adding up to the local days', async () => {
  await withUsers(world, async (make) => {
    const { authorization } = await make('admin');
    const body = await call(authorization, '/detailed', {
      startDate: world.start, endDate: world.end, reportDimensions: 'date,hour', allRows: 'true',
      reportMetrics: 'total_line_item_level_cpm_and_cpc_revenue,total_line_item_level_impressions',
    });
    assert.strictEqual(body.timezone?.applied, true, JSON.stringify(body.timezone));
    const rows = body.rows || [];
    assert.ok(rows.length >= 24, `hour rows: ${rows.length}`);
    assert.ok(rows.every((r) => r.dimensions.hour >= 0 && r.dimensions.hour <= 23 && r.dimensions.date >= world.start && r.dimensions.date <= world.end));
    const days = await hv.hourlyTrend({ clientId: world.clientId, startDate: world.start, endDate: world.end, tz: TZ, srcTz: world.srcTz, kind: 'network' });
    for (const d of days) {
      near(rows.filter((r) => r.dimensions.date === d.date).reduce((a, r) => a + r.revenue, 0), d.earning, `hours of ${d.date}`, 0.5);
    }
  });
});

check('admin Reporting with a site filter returns only that site', async () => {
  await withUsers(world, async (make) => {
    const { authorization } = await make('admin');
    const site = world.sites[0];
    const body = await call(authorization, '/detailed', {
      startDate: world.start, endDate: world.end, reportDimensions: 'date,site_name', site, allRows: 'true',
    });
    assert.strictEqual(body.timezone?.applied, true);
    assert.ok(body.rows.length > 0 && body.rows.every((r) => String(r.siteName).toLowerCase() === site.toLowerCase()));
    const want = await expectedSites(world, [site]);
    near(body.rows.reduce((a, r) => a + r.revenue, 0), want.revenue, 'site revenue', Math.max(1, want.revenue * 0.002));
  });
});

check('domain user: Dashboard, Reporting and the Domain User page show only the assigned sites, in the chosen timezone', async () => {
  await withUsers(world, async (make) => {
    const { authorization } = await make('child', { allowedSites: world.sites });
    const want = await expectedSites(world, world.sites);
    assert.ok(want.revenue > 0, 'the assigned sites earned something');
    const tol = Math.max(1, want.revenue * 0.003);

    const overview = await call(authorization, '/dashboard/overview', { startDate: world.start, endDate: world.end });
    assert.strictEqual(overview.timezone?.applied, true, JSON.stringify(overview.timezone));
    near(overview.summary.revenue, want.revenue, 'domain user overview', tol);

    const dash = await call(authorization, '/dashboard', { startDate: world.start, endDate: world.end });
    near(dash.summary.revenue, want.revenue, 'domain user dashboard', tol);
    const allowed = new Set(world.sites.map((s) => s.toLowerCase()));
    assert.ok(dash.rows.length > 0 && dash.rows.every((r) => allowed.has(String(r.siteName).toLowerCase())), 'only assigned sites in the table');

    const report = await call(authorization, '/detailed', {
      startDate: world.start, endDate: world.end, reportDimensions: 'date,domain,site_name', allRows: 'true',
    });
    assert.strictEqual(report.timezone?.applied, true);
    near(report.rows.reduce((a, r) => a + r.revenue, 0), want.revenue, 'domain user reporting', tol);
    assert.ok(report.rows.every((r) => allowed.has(String(r.siteName).toLowerCase())));

    const page = await call(authorization, '/domain-user', { startDate: world.start, endDate: world.end, allRows: 'true' });
    assert.strictEqual(page.timezone?.applied, true, JSON.stringify(page.timezone));
    near(page.rows.reduce((a, r) => a + r.revenue, 0), want.revenue, 'domain user page', tol);
    assert.ok(page.rows.every((r) => allowed.has(String(r.siteName).toLowerCase())));
  });
});

check('domain user: a domain assignment covers every site under that domain', async () => {
  await withUsers(world, async (make) => {
    const site = world.sites[0];
    const root = (site.match(/[^.]+\.[^.]+$/) || [site])[0];
    const { authorization } = await make('child', { allowedDomains: [root] });
    const want = await expectedSites(world, [], { domains: [root] });
    const overview = await call(authorization, '/dashboard/overview', { startDate: world.start, endDate: world.end });
    assert.strictEqual(overview.timezone?.applied, true);
    near(overview.summary.revenue, want.revenue, 'domain assignment', Math.max(1, want.revenue * 0.003));
  });
});

check('domain user without revenue permission never receives revenue in another timezone', async () => {
  await withUsers(world, async (make) => {
    const { authorization } = await make('child', { allowedSites: world.sites, canSeeRevenue: false });
    const overview = await call(authorization, '/dashboard/overview', { startDate: world.start, endDate: world.end });
    assert.strictEqual(overview.summary.revenue, 0);
    const page = await call(authorization, '/domain-user', { startDate: world.start, endDate: world.end, allRows: 'true' });
    assert.ok(page.rows.every((r) => !r.revenue), 'revenue is zeroed in the rows');
    assert.strictEqual(page.summary.totalRevenue, 0);
  });
});

check('a domain user with no assigned inventory gets nothing in another timezone', async () => {
  await withUsers(world, async (make) => {
    const { authorization } = await make('child', {});
    const overview = await call(authorization, '/dashboard/overview', { startDate: world.start, endDate: world.end });
    assert.strictEqual(overview.summary.revenue, 0);
    assert.notStrictEqual(overview.timezone?.applied, true);
  });
});

(async () => {
  world = await setup();
  if (!world || !world.sites.length) { console.log('skip: no hourly data in the local database'); process.exit(0); }
  console.log(`network ${String(world.clientId).slice(0, 8)} (${world.srcTz}) viewed in ${TZ}, ${world.start}..${world.end}, sites: ${world.sites.join(', ')}`);
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
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
