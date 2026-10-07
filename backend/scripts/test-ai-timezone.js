/**
 * Checks that the AI services read the same days the user is viewing when they pick another timezone for a
 * Google Ad Manager network: preset analysis facts, Ask AI tools, "Why did it change?" and the forecast.
 * No model is called; these are the figures the AI would be given.
 *
 *   node scripts/test-ai-timezone.js   (npm run test:ai runs it with the other AI checks)
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';
process.env.AI_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.AI_PROVIDER = 'anthropic';

const assert = require('assert');
const db = require('../src/db');
const { createUser, deleteUser, getUserById } = require('../src/models/userStore');
const { rotateUserSession } = require('../src/utils/sessionManager');
const { generateTokens } = require('../src/middleware/auth');
const { buildFacts } = require('../src/ai/presetAnalysis');
const { executeTool } = require('../src/ai/ask/tools');
const { explainFigures } = require('../src/ai/explain');
const forecast = require('../src/ai/forecast');
const { buildMessages } = require('../src/ai/ask');
const { resolveViewTz } = require('../src/ai/viewTz');
const hv = require('../src/services/hourlyView');
const { getNetworkTz } = require('../src/services/networkTimezone');
const { getClientById } = require('../src/models/clientStore');
const { shiftYMD, ymdInTZ } = require('../src/utils/datetime');

const TZ = 'Pacific/Honolulu'; // a zone a long way from any real network
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

let world;

async function setup() {
  const { rows } = await db.schemaQuery(`SELECT client_id FROM rollup_hourly WHERE kind = 'inventory' GROUP BY client_id ORDER BY COUNT(*) DESC LIMIT 1`);
  const clientId = rows[0]?.client_id;
  if (!clientId) return null;
  const srcTz = await getNetworkTz(await getClientById(clientId));
  const cov = await hv.coverage(clientId, TZ, ymdInTZ(new Date(), TZ), srcTz);
  if (!cov) return null;
  const end = cov.partialDay === cov.through ? shiftYMD(cov.through, -1) : cov.through;
  return { clientId, srcTz, start: shiftYMD(end, -2), end, covFrom: cov.from };
}

async function withAdmin(fn) {
  const id = `user-aitest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    await createUser({ id, username: `aitest_${id.slice(-9)}`, password: 'Test#12345x', role: 'admin', permissions: {}, clientId: world.clientId });
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    const authorization = `Bearer ${generateTokens(user, sid).accessToken}`;
    const base = { userId: id, clientId: world.clientId, role: 'admin' };
    const network = { ...base, viewTz: null, networkTz: world.srcTz, dayTz: world.srcTz };
    const viewed = { ...base, viewTz: TZ, networkTz: world.srcTz, dayTz: TZ };
    await fn({ authorization, network, viewed });
  } finally {
    await deleteUser(id).catch(() => {});
    await db.schemaQuery('DELETE FROM ai_usage_log WHERE user_id = $1', [id]).catch(() => {});
  }
}

/** First number in the fact whose text starts with `label`, e.g. "Revenue US$14,904.89 (...)" -> 14904.89. */
const money = (facts, label) => {
  const fact = Object.values(facts).find((f) => String(f.display).startsWith(label));
  const m = String(fact?.display || '').slice(label.length).match(/[0-9][0-9,]*(\.[0-9]+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

check('the request context says which timezone to read (header ignored when it is the network zone or invalid)', async () => {
  const req = (h) => ({ headers: h, client: { id: world.clientId, timeZone: world.srcTz, refreshToken: null } });
  assert.deepStrictEqual(await resolveViewTz(req({})), { viewTz: null, networkTz: world.srcTz, dayTz: world.srcTz });
  assert.strictEqual((await resolveViewTz(req({ 'x-report-tz': TZ }))).dayTz, TZ);
  assert.strictEqual((await resolveViewTz(req({ 'x-report-tz': world.srcTz }))).viewTz, null);
  assert.strictEqual((await resolveViewTz(req({ 'x-report-tz': 'Not/AZone' }))).viewTz, null);
});

check('preset analysis facts: another timezone gives different figures and says which zone the days are in', async () => {
  await withAdmin(async ({ authorization, network, viewed }) => {
    const body = { product: 'gam', kind: 'dashboard', startDate: world.start, endDate: world.end, filters: {}, depth: 'fast' };
    const own = await buildFacts({ authorization, ctx: network, body });
    const other = await buildFacts({ authorization, ctx: viewed, body });
    const a = money(own.final.facts, 'Revenue');
    const b = money(other.final.facts, 'Revenue');
    assert.ok(a > 0 && b > 0 && a !== b, `revenue differs by zone: ${a} vs ${b}`);
    assert.ok(other.final.prompt.notes.some((n) => n.includes(TZ)), JSON.stringify(other.final.prompt.notes));
    assert.ok(!own.final.prompt.notes.some((n) => n.includes('selected timezone')));
  });
});

check('Ask AI tools: site split, trend and summary follow the zone; splits that are only stored by day say so', async () => {
  await withAdmin(async ({ authorization, network, viewed }) => {
    const input = { product: 'gam', dimension: 'site', start_date: world.start, end_date: world.end, limit: 3 };
    const own = JSON.parse(await executeTool('get_breakdown', input, { authorization, ctx: network }));
    const other = JSON.parse(await executeTool('get_breakdown', input, { authorization, ctx: viewed }));
    assert.ok(other.total_earnings > 0 && other.total_earnings !== own.total_earnings);
    assert.match(other.note, new RegExp(TZ));
    assert.doesNotMatch(own.note || '', /selected timezone/);

    const trend = JSON.parse(await executeTool('get_daily_trend', { product: 'gam', start_date: world.start, end_date: world.end }, { authorization, ctx: viewed }));
    assert.strictEqual(trend.rows.length, 3);
    assert.match(trend.note, new RegExp(TZ));

    const byCountry = JSON.parse(await executeTool('get_breakdown', { product: 'gam', dimension: 'country', start_date: world.start, end_date: world.end, limit: 2 }, { authorization, ctx: viewed }));
    assert.match(byCountry.note, /network timezone/, 'a split that has no hourly data is labelled with the network zone');

    const sum = JSON.parse(await executeTool('get_summary', { product: 'gam', page: 'dashboard', start_date: world.start, end_date: world.end }, { authorization, ctx: viewed }));
    assert.ok(sum.notes.some((n) => n.includes(TZ)));
  });
});

check('Ask AI tells the model which zone "today" is in', async () => {
  const m = buildMessages({ question: 'revenue today', context: { product: 'gam', page: 'dashboard' }, ctx: { viewTz: TZ, networkTz: world.srcTz, dayTz: TZ } });
  const text = m[m.length - 1].content;
  assert.match(text, new RegExp(`Today is ${ymdInTZ(new Date(), TZ)} \\(${TZ}\\)`));
  assert.match(text, /viewing Google Ad Manager in the Pacific\/Honolulu timezone/);
  const pub = buildMessages({ question: 'x', context: { product: 'adsense', page: 'dashboard' }, ctx: { viewTz: TZ, networkTz: world.srcTz, dayTz: TZ } });
  assert.doesNotMatch(pub[pub.length - 1].content, /viewing Google Ad Manager/, 'AdSense pages keep their own days');
});

check('Why did it change: the figures come from the selected zone', async () => {
  await withAdmin(async ({ authorization, network, viewed }) => {
    const body = { product: 'gam', startDate: world.start, endDate: world.end };
    const own = await explainFigures({ authorization, ctx: network, body });
    const other = await explainFigures({ authorization, ctx: viewed, body });
    assert.notStrictEqual(own.earnings.now, other.earnings.now);
    assert.strictEqual(other.days_timezone, TZ);
    assert.strictEqual(own.days_timezone, world.srcTz);
  });
});

check('forecast: months and "today" follow the zone; older days stay in the network zone', async () => {
  await withAdmin(async ({ authorization, network, viewed }) => {
    const own = await forecast.forecastProduct({ authorization, ctx: network, body: { product: 'gam' } });
    const other = await forecast.forecastProduct({ authorization, ctx: viewed, body: { product: 'gam' } });
    assert.strictEqual(own.figures.timezone, null);
    assert.strictEqual(other.figures.timezone?.tz, TZ);
    assert.ok(typeof other.figures.timezone.applied === 'boolean');
    assert.strictEqual(other.figures.month.today, ymdInTZ(new Date(), TZ));
    assert.ok(other.figures.ok, other.figures.reason);
  });
});

(async () => {
  world = await setup();
  if (!world) { console.log('skip: no hourly data in the local database'); process.exit(0); }
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
