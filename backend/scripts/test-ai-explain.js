/**
 * Checks "Why did it change?" and the AdSense filter fix against the local database, with a stand-in model.
 *
 *   npm run test:ai   (runs this with the other AI checks)
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';
process.env.AI_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key';
// These checks drive the Anthropic-shaped test client, whatever the .env says.
process.env.AI_PROVIDER = 'anthropic';

const assert = require('assert');
const db = require('../src/db');
const { createUser, deleteUser, getUserById } = require('../src/models/userStore');
const { rotateUserSession } = require('../src/utils/sessionManager');
const { generateTokens } = require('../src/middleware/auth');
const provider = require('../src/ai/provider');
const { AiError } = require('../src/ai/errors');
const { decomposeTotals, decomposeDimension } = require('../src/ai/explain/decompose');
const { explainChange, explainFigures } = require('../src/ai/explain');
const { reliableDims } = require('../src/ai/presetAnalysis/common');
const { executeTool } = require('../src/ai/ask/tools');
const { callRouter } = require('../src/ai/internalCall');

let modelCalls = 0;
let modelMode = 'ok';
provider.setClientForTests({
  messages: {
    stream(params) {
      modelCalls += 1;
      const sheet = JSON.parse(params.messages[0].content.replace('Fact sheet:\n', ''));
      const ids = Object.keys(sheet.facts);
      const json = JSON.stringify({
        headline: 'Headline.',
        explanation: 'Explanation.',
        points: [{ text: 'P1', factIds: [ids[0], 'F9999'] }, { text: 'P2', factIds: [] }, { text: 'P3', factIds: [] }],
      });
      const h = {};
      const s = {
        on(ev, cb) { h[ev] = cb; return s; },
        async finalMessage() {
          if (modelMode === 'fail') throw new AiError('ai_timeout', 'slow', { status: 504 });
          h.text?.(json);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: json }], usage: { input_tokens: 1000, output_tokens: 100 } };
        },
      };
      return s;
    },
  },
});

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const RANGE = { startDate: '2026-09-24', endDate: '2026-09-30' };

async function withAdmin(fn) {
  const { rows } = await db.schemaQuery(
    `SELECT c.publisher_parent_id AS id FROM gam_clients c JOIN adsense_accounts a ON a.client_id = c.id
     WHERE c.publisher_parent_id IS NOT NULL LIMIT 1`
  );
  const id = `user-aitest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    await createUser({ id, username: `aitest_${id.slice(-8)}`, password: 'Test#12345x', role: 'admin', permissions: {}, clientId: rows[0]?.id });
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    const { accessToken } = generateTokens(user, sid);
    await fn({ user, authorization: `Bearer ${accessToken}`, ctx: { userId: id, clientId: user.clientId } });
  } finally {
    await deleteUser(id).catch(() => {});
    await db.schemaQuery('DELETE FROM ai_usage_log WHERE user_id = $1', [id]).catch(() => {});
  }
}

check('decompose: every cause adds up to the change (hand-computed example)', async () => {
  // Prior: A 1000 @ $2, B 1000 @ $4, C 500 @ $1.  Now: A 800 @ $1.5, B 1500 @ $4, D (new) 100 @ $5.
  const prev = [{ name: 'A', earnings: 2000, volume: 1000 }, { name: 'B', earnings: 4000, volume: 1000 }, { name: 'C', earnings: 500, volume: 500 }];
  const cur = [{ name: 'A', earnings: 1200, volume: 800 }, { name: 'B', earnings: 6000, volume: 1500 }, { name: 'D', earnings: 500, volume: 100 }];
  const d = decomposeDimension(cur, prev, { earningsNow: 7700, earningsPrev: 6500 });
  assert.deepStrictEqual(d.effects, { pureVolume: 900, mix: 700, price: -400, newItems: 500, lostItems: -500, other: 0 });
  assert.strictEqual(Object.values(d.effects).reduce((a, b) => a + b, 0), d.totalDelta);
  assert.strictEqual(d.items[0].name, 'B');
  assert.deepStrictEqual(d.items.find((i) => i.name === 'D').status, 'new');
  assert.deepStrictEqual(d.items.find((i) => i.name === 'C').status, 'lost');
  const t = decomposeTotals({ earningsNow: 133954.94, earningsPrev: 160820.5, volumeNow: 61990841, volumePrev: 74000000 });
  assert.ok(Math.abs(t.volume + t.price - t.delta) < 0.02);
  // a partial list leaves the rest in "other" and still adds up
  const partial = decomposeDimension(cur.slice(0, 1), prev.slice(0, 1), { earningsNow: 7700, earningsPrev: 6500 });
  assert.ok(Math.abs(Object.values(partial.effects).reduce((a, b) => a + b, 0) - partial.totalDelta) < 0.02);
  decomposeDimension(null, undefined, { earningsNow: 0, earningsPrev: 0 });
});

check('splits: with a filter only the split it can narrow is kept', async () => {
  const dims = ['site', 'country', 'platform'];
  assert.deepStrictEqual(reliableDims({}, dims).dims, dims);
  assert.deepStrictEqual(reliableDims({ sites: ['a'] }, dims).dims, ['site']);
  assert.match(reliableDims({ sites: ['a'] }, dims).note, /cannot be narrowed/);
  assert.deepStrictEqual(reliableDims({ sites: ['a'], countries: ['IN'] }, dims).dims, []);
  assert.match(reliableDims({ sites: ['a'], countries: ['IN'] }, dims).note, /approximately/);
  assert.deepStrictEqual(reliableDims({ sites: [] }, dims).dims, dims, 'an empty filter is no filter');
});

check('AdSense: filtered totals and trend equal the matching breakdown row', async () => withAdmin(async ({ authorization }) => {
  const adsense = require('../src/routes/adsense');
  const get = async (path, extra = {}) => (await callRouter(adsense, { path, query: { ...RANGE, ...extra }, authorization })).body;
  const all = await get('/overview');
  const rows = (await get('/breakdowns', { dim: 'site', limit: 50 })).rows;
  const top = rows[0];
  const filtered = await get('/overview', { sites: top.name });
  assert.ok(Math.abs(filtered.totals.earnings - top.earnings) < 0.01);
  assert.ok(filtered.totals.earnings <= all.totals.earnings);
  assert.strictEqual(filtered.source, 'filtered-dims');
  const trend = await get('/trend', { sites: top.name });
  assert.ok(Math.abs(trend.trend.reduce((a, t) => a + t.earnings, 0) - top.earnings) < 0.01);
  assert.strictEqual((await get('/overview', { sites: 'no-such-site.example' })).totals.earnings, 0);
  assert.strictEqual((await get('/overview')).totals.earnings, all.totals.earnings, 'no filter: unchanged');
}));

check('explain: exact figures first, explanation after, every cause adds up', async () => withAdmin(async ({ authorization, ctx }) => {
  const events = [];
  const r = await explainChange({ authorization, ctx, body: { product: 'adsense', ...RANGE }, emit: (e) => events.push(e) });
  assert.deepStrictEqual(events, ['drivers', 'result']);
  assert.strictEqual(r.meta.source, 'ai');
  assert.ok(!JSON.stringify(r).includes('F9999'), 'invented fact ids are dropped');
  const d = r.drivers;
  assert.ok(d.dimensions.length >= 1);
  for (const dim of d.dimensions) {
    const sum = Object.values(dim.effects).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - d.totals.delta) < 0.05, `${dim.by}: effects ${sum} vs change ${d.totals.delta}`);
  }
  assert.ok(Math.abs(d.aggregate.volume + d.aggregate.price - d.totals.delta) < 0.05);
  const before = modelCalls;
  await explainChange({ authorization, ctx, body: { product: 'adsense', ...RANGE } });
  assert.strictEqual(modelCalls, before, 'identical figures reuse the stored explanation');
}));

check('explain: GAM uses totals only; a failing model falls back to rules; tiny changes skip the model', async () => withAdmin(async ({ authorization, ctx }) => {
  const gam = await explainChange({ authorization, ctx, body: { product: 'gam', ...RANGE } });
  assert.deepStrictEqual(gam.drivers.dimensions, []);
  assert.ok(Math.abs(gam.drivers.aggregate.volume + gam.drivers.aggregate.price - gam.drivers.totals.delta) < 0.05);

  modelMode = 'fail';
  try {
    const r = await explainChange({ authorization, ctx, body: { product: 'adsense', ...RANGE, filters: { sites: [(await callRouter(require('../src/routes/adsense'), { path: '/breakdowns', query: { ...RANGE, dim: 'site', limit: 3 }, authorization })).body.rows[1].name] } } });
    assert.strictEqual(r.meta.source, 'rules');
    assert.strictEqual(r.meta.error.code, 'ai_timeout');
    assert.match(r.headline, /earnings (rose|fell)/);
    assert.deepStrictEqual(r.drivers.dimensions.map((d) => d.by), ['Site'], 'only the split the filter can narrow');
    assert.match(r.drivers.note, /cannot be narrowed/);
  } finally {
    modelMode = 'ok';
  }

  const before = modelCalls;
  const small = await explainChange({ authorization, ctx, body: { product: 'admob', ...RANGE } });
  assert.strictEqual(small.drivers.tooSmall, true);
  assert.strictEqual(modelCalls, before);
}));

check('explain: bad requests are rejected', async () => withAdmin(async ({ authorization, ctx }) => {
  await assert.rejects(() => explainChange({ authorization, ctx, body: { product: 'nope', ...RANGE } }), /Unknown product/);
  await assert.rejects(() => explainChange({ authorization, ctx, body: { product: 'adsense', startDate: 'x', endDate: 'y' } }), /YYYY-MM-DD/);
}));

check('chat tool: explain_change returns compact figures and rejects bad input', async () => withAdmin(async ({ authorization }) => {
  const out = JSON.parse(await executeTool('explain_change', { product: 'AdSense', start_date: RANGE.startDate, end_date: RANGE.endDate }, { authorization }));
  assert.strictEqual(out.product, 'AdSense');
  assert.ok(out.earnings.change_pct && out.from_traffic_alone && out.from_price_alone);
  assert.ok(out.views.length >= 1 && out.views[0].biggest_movers.length >= 1);
  await assert.rejects(() => executeTool('explain_change', { product: 'nope', start_date: RANGE.startDate, end_date: RANGE.endDate }, { authorization }), /product must be one of/);
  const figures = await explainFigures({ authorization, body: { product: 'gam', ...RANGE } });
  assert.strictEqual(figures.views.length, 0);
}));

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
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
