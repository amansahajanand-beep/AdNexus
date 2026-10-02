/**
 * Checks the ask-your-data chat and the weekly report against the local database, with a stand-in model.
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
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const provider = require('../src/ai/provider');
const { AiError } = require('../src/ai/errors');
const { askData } = require('../src/ai/ask');
const reports = require('../src/ai/report');
const { accountIdFor } = require('../src/ai/accounts');

// Each model call takes the next scripted reply: a function (params) -> message, or an Error to throw.
let script = [];
const requests = [];
provider.setClientForTests({
  messages: {
    stream(params) {
      requests.push(params);
      const next = script.shift();
      const msg = typeof next === 'function' ? next(params) : next;
      const h = {};
      const s = {
        on(ev, cb) { h[ev] = cb; return s; },
        async finalMessage() {
          if (msg instanceof Error) throw msg;
          for (const b of msg.content || []) if (b.type === 'text') h.text?.(b.text);
          return { usage: { input_tokens: 1000, output_tokens: 100 }, ...msg };
        },
      };
      return s;
    },
  },
});

const end = shiftYMD(todayInTZ(), -1);
const start = shiftYMD(end, -6);
const range = { start_date: start, end_date: end };
const toolTurn = (...calls) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: '', signature: 's' }, ...calls.map((c, i) => ({ type: 'tool_use', id: `t${i}`, name: c[0], input: c[1] }))],
});
const answer = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const lastToolResults = () => requests[requests.length - 1].messages.slice(-1)[0].content.filter((b) => b.type === 'tool_result');

async function withUser(role, fn) {
  const { rows } = await db.schemaQuery(
    `SELECT c.publisher_parent_id AS id FROM gam_clients c JOIN adsense_accounts a ON a.client_id = c.id
     WHERE c.publisher_parent_id IS NOT NULL LIMIT 1`
  );
  const id = `user-aitest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    await createUser({ id, username: `aitest_${id.slice(-8)}`, password: 'Test#12345x', role, permissions: {}, clientId: rows[0]?.id });
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    const { accessToken } = generateTokens(user, sid);
    await fn({ user, authorization: `Bearer ${accessToken}`, ctx: { userId: id, clientId: user.clientId } });
  } finally {
    await deleteUser(id).catch(() => {});
    await db.schemaQuery('DELETE FROM ai_usage_log WHERE user_id = $1', [id]).catch(() => {});
  }
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('ask: parallel tools read real data and the answer follows', async () => withUser('admin', async ({ authorization, ctx }) => {
  requests.length = 0;
  script = [
    toolTurn(['get_summary', { product: 'adsense', page: 'dashboard', ...range }], ['get_breakdown', { product: 'adsense', dimension: 'site', ...range, limit: 3 }]),
    answer('Done.'),
  ];
  const events = [];
  const r = await askData({ question: 'How did AdSense do?', authorization, ctx, emit: (e) => events.push(e) });
  assert.strictEqual(r.answer, 'Done.');
  assert.strictEqual(r.steps.length, 2);
  assert.ok(events.includes('tool') && events.includes('done'));
  const results = lastToolResults();
  assert.ok(results.every((b) => !b.is_error), 'both tools succeeded');
  assert.ok(JSON.parse(results[1].content).rows.length >= 1, 'breakdown has rows');
  assert.strictEqual(requests[1].messages[1].content[0].type, 'thinking', 'assistant content is passed back unchanged');
  assert.ok(/^Today is \d{4}-\d{2}-\d{2}/.test(requests[0].messages[0].content), 'the date is given to the model');
}));

check('ask: bad arguments come back as errors the model can fix', async () => withUser('admin', async ({ authorization, ctx }) => {
  requests.length = 0;
  script = [toolTurn(['get_breakdown', { product: 'adsense', dimension: 'app', ...range }], ['get_summary', { product: 'admob', page: 'dashboard', start_date: 'yesterday', end_date: end }]), answer('ok')];
  await askData({ question: 'x', authorization, ctx });
  const results = lastToolResults();
  assert.ok(results.every((b) => b.is_error));
  assert.match(results[0].content, /dimension for adsense/);
  assert.match(results[1].content, /YYYY-MM-DD/);
}));

check('ask: tool rounds are capped and the model is told to answer', async () => withUser('admin', async ({ authorization, ctx }) => {
  requests.length = 0;
  script = [...Array.from({ length: 5 }, () => toolTurn(['find_filter_values', { product: 'admob', dimension: 'country' }])), answer('Final.')];
  const r = await askData({ question: 'loop', authorization, ctx });
  assert.strictEqual(r.answer, 'Final.');
  assert.strictEqual(requests.length, 6);
  assert.ok(requests[5].messages.slice(-1)[0].content.some((b) => b.type === 'text' && /last tool call/.test(b.text)));
}));

check('ask: unreadable tool JSON is retried; refusals and empty questions are handled', async () => withUser('admin', async ({ authorization, ctx }) => {
  script = [new Error('Unexpected token'), answer('Recovered.')];
  assert.strictEqual((await askData({ question: 'hi', authorization, ctx })).answer, 'Recovered.');
  script = [{ stop_reason: 'refusal', content: [] }];
  assert.match((await askData({ question: 'hi', authorization, ctx })).answer, /can't help/);
  await assert.rejects(() => askData({ question: '  ', authorization, ctx }), (e) => e.code === 'ai_bad_request');
}));

check('ask: a domain user is told plainly when data is off limits', async () => withUser('child', async ({ authorization, ctx }) => {
  requests.length = 0;
  script = [toolTurn(['get_summary', { product: 'admob', page: 'roi', ...range }]), answer('ok')];
  await askData({ question: 'ROI?', authorization, ctx });
  const [result] = lastToolResults();
  assert.ok(result.is_error);
  assert.match(result.content, /not allowed/);
}));

check('report: written from cited facts, reused, forced, and falls back to rules', async () => withUser('admin', async ({ user, authorization, ctx }) => {
  const accountId = await accountIdFor(user);
  await db.schemaQuery('DELETE FROM ai_reports WHERE account_id = $1', [accountId]);
  const modelReport = (params) => {
    const sheets = JSON.parse(params.messages[0].content.split('Fact sheets:\n')[1]);
    const first = Object.keys(sheets[0].facts)[0];
    return answer(JSON.stringify({
      headline: 'Headline.',
      summary: 'Summary.',
      sections: [{ product: sheets[0].product, summary: 's', points: [{ severity: 'info', text: 'p', factIds: [first, 'NOPE-F1'] }] }, { product: 'facebook', summary: 'x', points: [] }],
      risks: [],
      actions: [{ title: 'Act', detail: 'd', factIds: [] }],
    }));
  };
  try {
    script = [modelReport];
    const r1 = await reports.generateWeeklyReport({ user, accountId, authorization, ctx });
    assert.strictEqual(r1.source, 'ai');
    assert.strictEqual(r1.content.sections.length, 1, 'unknown product dropped');
    assert.ok(!JSON.stringify(r1.content).includes('NOPE-F1'), 'invented fact dropped');
    assert.strictEqual(Object.keys(r1.facts).length, 1, 'only cited facts are stored');

    const r2 = await reports.generateWeeklyReport({ user, accountId, authorization, ctx });
    assert.strictEqual(r2.reused, true);

    script = [new AiError('ai_timeout', 'slow', { status: 504 })];
    const r3 = await reports.generateWeeklyReport({ user, accountId, authorization, ctx, force: true });
    assert.strictEqual(r3.source, 'rules');
    assert.ok(r3.content.headline);

    assert.strictEqual((await reports.listReports(accountId)).length, 2);
    assert.strictEqual(await reports.getReport('another-account', r1.id), null);
  } finally {
    await db.schemaQuery('DELETE FROM ai_reports WHERE account_id = $1', [accountId]);
  }
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
