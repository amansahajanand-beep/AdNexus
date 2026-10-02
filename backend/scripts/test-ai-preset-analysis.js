/**
 * Checks the preset AI analysis end to end against the local database, with a stand-in model
 * (no network, no API key needed). Creates a throwaway admin and cleans up after itself.
 *
 *   npm run test:ai
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
const { analyzePreset } = require('../src/ai/presetAnalysis');
const { AiError } = require('../src/ai/errors');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

let modelCalls = 0;
let failModel = false;

function installFakeModel() {
  provider.setClientForTests({
    messages: {
      stream(params) {
        modelCalls += 1;
        const sheet = JSON.parse(params.messages[0].content.replace('Fact sheet:\n', ''));
        const ids = Object.keys(sheet.facts);
        const deep = params.system[0].text.includes('deep analysis');
        const json = JSON.stringify({
          headline: `About ${sheet.page}`,
          summary: 'Summary.',
          findings: [
            { severity: 'warning', title: 'A finding', detail: 'Detail.', factIds: [ids[0], 'F9999'].filter(Boolean) },
            { severity: 'not-a-severity', title: 'Another', detail: 'Detail.', factIds: [] },
          ],
          actions: [{ title: 'An action', detail: 'Detail.', factIds: [] }],
          ...(deep ? { deepDive: [{ title: 'Driver', body: 'Body.', factIds: [] }], confidence: { level: 'high', note: 'ok' } } : {}),
        });
        const handlers = {};
        const stream = {
          on(ev, cb) { handlers[ev] = cb; return stream; },
          async finalMessage() {
            if (failModel) throw new AiError('ai_timeout', 'slow', { status: 504 });
            handlers.text?.(json);
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: json }], usage: { input_tokens: 900, output_tokens: 200 } };
          },
        };
        return stream;
      },
    },
  });
}

/** A GAM network whose account owns AdSense data, so the publisher endpoints have something to read. */
async function pickClientId() {
  if (process.env.AI_TEST_CLIENT_ID) return process.env.AI_TEST_CLIENT_ID;
  const { rows } = await db.schemaQuery(
    `SELECT c.publisher_parent_id AS id
     FROM gam_clients c JOIN adsense_accounts a ON a.client_id = c.id
     WHERE c.publisher_parent_id IS NOT NULL LIMIT 1`
  );
  return rows[0]?.id || undefined;
}

async function withUser(role, fn) {
  const clientId = await pickClientId();
  const id = `user-aitest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    await createUser({ id, username: `aitest_${id.slice(-8)}`, password: 'Test#12345x', role, permissions: {}, clientId });
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    const { accessToken } = generateTokens(user, sid);
    await fn({ user, authorization: `Bearer ${accessToken}` });
  } finally {
    await deleteUser(id).catch(() => {});
    await db.schemaQuery('DELETE FROM ai_usage_log WHERE user_id = $1', [id]).catch(() => {});
  }
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

async function run(ctx, body, extra = {}) {
  const events = [];
  const result = await analyzePreset({
    authorization: ctx.authorization,
    ctx: { userId: ctx.user.id, clientId: ctx.user.clientId },
    body: { startDate: shiftYMD(todayInTZ(), -7), endDate: shiftYMD(todayInTZ(), -1), ...body },
    emit: (e) => events.push(e),
    ...extra,
  });
  return { result, events };
}

check('streams facts, headline and result; validates model output', async (ctx) => {
  const { result, events } = await run(ctx, { product: 'adsense', kind: 'dashboard', filters: {} });
  assert.deepStrictEqual(events, ['facts', 'headline', 'result']);
  assert.strictEqual(result.meta.source, 'ai');
  assert.ok(result.analysis.headline.startsWith('About'));
  assert.strictEqual(result.analysis.findings[1].severity, 'info', 'unknown severity becomes info');
  assert.ok(!JSON.stringify(result.analysis).includes('F9999'), 'invented fact ids are dropped');
});

check('chart data and structured figures come with the analysis (and never reach the model)', async (ctx) => {
  const events = [];
  const result = await analyzePreset({
    authorization: ctx.authorization,
    ctx: { userId: ctx.user.id, clientId: ctx.user.clientId },
    body: { product: 'adsense', kind: 'dashboard', filters: {}, startDate: shiftYMD(todayInTZ(), -7), endDate: shiftYMD(todayInTZ(), -1) },
    emit: (e, data) => events.push([e, data]),
  });
  const early = events.find(([e]) => e === 'facts')[1];
  assert.ok(early.charts && early.currency, 'charts are sent with the early facts');
  assert.deepStrictEqual(result.charts, early.charts);
  assert.ok(early.charts.trend.points.length >= 2, 'daily trend');
  assert.ok(early.charts.breakdowns.length >= 1 && early.charts.breakdowns[0].items.length >= 1, 'ranked breakdown');
  const item = early.charts.breakdowns[0].items[0];
  assert.ok(typeof item.name === 'string' && Number.isFinite(item.value));
  const kpi = early.facts[early.metricIds[0]];
  assert.ok(kpi.label && kpi.valueText && kpi.unit, 'figure tiles have label, value text and unit');
});

check('AI is for admins only: domain users are refused unless AI_ADMIN_ONLY=false', async () => {
  const { resolveAiAccess } = require('../src/ai/flags');
  const domain = { role: 'user', clientId: null };
  const saved = { adminOnly: process.env.AI_ADMIN_ONLY, def: process.env.AI_DEFAULT_ENABLED };
  process.env.AI_DEFAULT_ENABLED = 'true';
  try {
    delete process.env.AI_ADMIN_ONLY;
    assert.deepStrictEqual(await resolveAiAccess(domain), { enabled: false, reason: 'admin_only' });
    assert.strictEqual((await resolveAiAccess({ role: 'admin', clientId: null })).enabled, true);
    process.env.AI_ADMIN_ONLY = 'false';
    assert.strictEqual((await resolveAiAccess(domain)).enabled, true);
  } finally {
    for (const [k, v] of [['AI_ADMIN_ONLY', saved.adminOnly], ['AI_DEFAULT_ENABLED', saved.def]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

check('repeat request uses the saved result; force asks the model again', async (ctx) => {
  const body = { product: 'adsense', kind: 'dashboard', filters: {} };
  await run(ctx, body);
  const before = modelCalls;
  const again = await run(ctx, body);
  assert.strictEqual(again.result.meta.cached, 'recent');
  assert.strictEqual(modelCalls, before);
  await run(ctx, { ...body, force: true });
  assert.strictEqual(modelCalls, before + 1);
});

check('identical data for another user reuses the stored analysis', async (ctx) => {
  const body = { product: 'admob', kind: 'dashboard', filters: {} };
  await run(ctx, body);
  const before = modelCalls;
  const other = await analyzePreset({
    authorization: ctx.authorization,
    ctx: { userId: 'another-user', clientId: ctx.user.clientId },
    body: { startDate: shiftYMD(todayInTZ(), -7), endDate: shiftYMD(todayInTZ(), -1), ...body },
  });
  assert.strictEqual(other.meta.cached, 'stored');
  assert.strictEqual(modelCalls, before);
});

check('deep tier returns a deep dive and confidence', async (ctx) => {
  const { result } = await run(ctx, { product: 'adsense', kind: 'dashboard', filters: {}, depth: 'deep' });
  assert.ok(result.analysis.deepDive.length >= 1);
  assert.strictEqual(result.analysis.confidence.level, 'high');
});

check('model failure falls back to rule-based output', async (ctx) => {
  failModel = true;
  try {
    const { result } = await run(ctx, { product: 'adsense', kind: 'dashboard', filters: {}, force: true });
    assert.strictEqual(result.meta.source, 'rules');
    assert.strictEqual(result.meta.error.code, 'ai_timeout');
    assert.ok(result.analysis.headline);
  } finally {
    failModel = false;
  }
});

check('no data skips the model', async (ctx) => {
  const before = modelCalls;
  const { result } = await run(ctx, { product: 'admob', kind: 'dashboard', filters: { apps: ['no-such-app-xyz'] } });
  assert.strictEqual(result.meta.source, 'rules');
  assert.strictEqual(modelCalls, before);
});

check('bad requests are rejected with a clear message', async (ctx) => {
  await assert.rejects(() => run(ctx, { product: 'nope', kind: 'dashboard' }), /Unknown product/);
  await assert.rejects(() => run(ctx, { product: 'admob', kind: 'dashboard', startDate: '2026-13-99' }), /between 1 and 400 days|YYYY-MM-DD/);
});

(async () => {
  installFakeModel();
  let failed = 0;
  await withUser('admin', async (ctx) => {
    for (const c of checks) {
      try {
        await c.fn(ctx);
        console.log(`ok   ${c.name}`);
      } catch (err) {
        failed += 1;
        console.log(`FAIL ${c.name}\n     ${err.message}`);
      }
    }
  });
  await withUser('child', async (ctx) => {
    try {
      await run(ctx, { product: 'admob', kind: 'roi', filters: {} });
      failed += 1;
      console.log('FAIL domain users must not read ROI');
    } catch (err) {
      assert.strictEqual(err.status, 403);
      console.log('ok   domain users cannot analyze admin-only ROI (403)');
    }
  });
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
