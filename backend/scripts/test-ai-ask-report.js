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

async function withUser(role, fn, { gamNetwork = false } = {}) {
  const { rows } = await db.schemaQuery(
    gamNetwork
      // A network that has GAM data loaded (the one an existing admin works in).
      ? `SELECT u.client_id AS id FROM users u JOIN user_report_presets p ON p.user_id = u.id WHERE u.client_id IS NOT NULL LIMIT 1`
      : `SELECT c.publisher_parent_id AS id FROM gam_clients c JOIN adsense_accounts a ON a.client_id = c.id
         WHERE c.publisher_parent_id IS NOT NULL LIMIT 1`
  );
  const id = `user-aitest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    await createUser({ id, username: `aitest_${id.slice(-8)}`, password: 'Test#12345x', role, permissions: {}, clientId: rows[0]?.id });
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    const { accessToken } = generateTokens(user, sid);
    await fn({ user, authorization: `Bearer ${accessToken}`, ctx: { userId: id, clientId: user.clientId, role: user.role } });
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

check('ask: Google Ad Manager revenue of one site (find the name, then split by site) and by domain', async () => withUser('admin', async ({ authorization, ctx }) => {
  requests.length = 0;
  let site = null;
  script = [
    toolTurn(
      ['find_filter_values', { product: 'gam', dimension: 'site', search: 'quiz' }],
      ['get_breakdown', { product: 'gam', dimension: 'site', ...range, limit: 1 }]
    ),
    (params) => {
      const [names, top] = params.messages.slice(-1)[0].content.filter((b) => b.type === 'tool_result').map((b) => JSON.parse(b.content));
      assert.strictEqual(names.filter_key, 'sites');
      assert.ok(names.values.length > 0, 'GAM site names are found');
      assert.strictEqual(top.rows.length, 1);
      site = top.rows[0].name; // a site that earned in this period
      return toolTurn(
        ['get_breakdown', { product: 'GAM', dimension: 'site', ...range, filters: { sites: [site] } }],
        ['get_breakdown', { product: 'gam', dimension: 'domain', ...range, limit: 3 }],
        ['get_daily_trend', { product: 'gam', ...range, filters: { sites: [site] } }],
        ['get_breakdown', { product: 'gam', dimension: 'site', ...range, filters: { sites: ['no-such-site.example'] } }],
        ['get_summary', { product: 'gam', page: 'dashboard', ...range, filters: { sites: [site] } }]
      );
    },
    answer('Done.'),
  ];
  assert.strictEqual((await askData({ question: 'revenue of a site last week', authorization, ctx })).answer, 'Done.');
  const [one, domains, trend, none, filteredSummary] = lastToolResults().map((b) => ({ error: b.is_error, body: b.is_error ? null : JSON.parse(b.content), text: b.content }));
  assert.ok(!one.error && !domains.error && !trend.error && !none.error, [one, domains, trend, none].map((r) => r.text).join('\n'));
  // A filter the summary cannot apply must be refused, never ignored (the network total would look like the site's).
  assert.ok(filteredSummary.error);
  assert.match(filteredSummary.text, /get_breakdown/);
  assert.deepStrictEqual(one.body.rows.map((r) => r.name), [site]);
  assert.strictEqual(one.body.rows[0].share_pct, 100);
  assert.strictEqual(one.body.currency, 'USD');
  assert.ok(domains.body.rows.length <= 3 && domains.body.items_matched >= domains.body.rows.length);
  const shares = domains.body.rows.reduce((a, r) => a + r.share_pct, 0);
  assert.ok(shares <= 100.5, 'shares are of the whole period');
  const trendTotal = trend.body.rows.reduce((a, r) => a + r.earnings, 0);
  assert.ok(Math.abs(trendTotal - one.body.rows[0].earnings) < 0.05, 'daily figures add up to the site total');
  assert.deepStrictEqual(none.body.rows, []);
  assert.match(none.body.note, /No rows matched/);
}, { gamNetwork: true }));

check('ask: Google Ad Manager by app, ad unit, country and device; combinations that are not stored are refused', async () => withUser('admin', async ({ authorization, ctx }) => {
  const { executeTool } = require('../src/ai/ask/tools');
  const run = async (name, input, as = ctx) => JSON.parse(await executeTool(name, { ...range, ...input }, { authorization, ctx: as }));
  const fails = (name, input, pattern, as = ctx) => assert.rejects(() => executeTool(name, { ...range, ...input }, { authorization, ctx: as }), pattern);

  for (const dimension of ['country', 'app', 'ad_unit', 'device']) {
    const out = await run('get_breakdown', { product: 'gam', dimension, limit: 3 });
    assert.ok(out.rows.length >= 1 && out.rows.length <= 3, `${dimension} rows`);
    assert.ok(out.rows[0].earnings >= out.rows[out.rows.length - 1].earnings, 'largest first');
    assert.ok(out.total_earnings >= out.rows.reduce((a, r) => a + r.earnings, 0) - 0.05);
    assert.match(out.note, /warehouse rollups/);
  }
  const top = (await run('get_breakdown', { product: 'gam', dimension: 'country', limit: 1 })).rows[0];
  // the same country asked for by name, in another case, gives the same row
  const one = await run('get_breakdown', { product: 'gam', dimension: 'country', filters: { countries: [top.name.toUpperCase()] } });
  assert.deepStrictEqual(one.rows.map((r) => [r.name, r.earnings]), [[top.name, top.earnings]]);
  assert.strictEqual(one.rows[0].share_pct, 100);
  const trend = await run('get_daily_trend', { product: 'gam', filters: { countries: [top.name] } });
  assert.ok(Math.abs(trend.rows.reduce((a, r) => a + r.earnings, 0) - top.earnings) < 0.05, 'daily figures add up to the country total');
  const names = await run('find_filter_values', { product: 'gam', dimension: 'country', search: top.name.slice(0, 3).toLowerCase() });
  assert.ok(names.values.includes(top.name) && names.filter_key === 'countries');
  const apps = await run('find_filter_values', { product: 'gam', dimension: 'app' });
  assert.strictEqual(apps.filter_key, 'apps');

  await fails('get_breakdown', { product: 'gam', dimension: 'country', filters: { apps: ['x'] } }, /cannot be filtered by apps/);
  await fails('get_breakdown', { product: 'gam', dimension: 'site', filters: { countries: ['India'] } }, /cannot be filtered by countries/);
  await fails('get_breakdown', { product: 'gam', dimension: 'country', filters: { sites: ['a.example'] } }, /cannot be filtered by sites/);
  await fails('get_breakdown', { product: 'gam', dimension: 'country', filters: { countries: ['India'], devices: ['Desktop'] } }, /cannot combine/);
  await fails('get_daily_trend', { product: 'gam', filters: { sites: ['a.example'], countries: ['India'] } }, /cannot combine/);
  await fails('get_breakdown', { product: 'gam', dimension: 'site', filters: { regions: ['x'] } }, /does not apply to Google Ad Manager/);
  await fails('get_breakdown', { product: 'gam', dimension: 'country' }, /only available to admins/, { ...ctx, role: 'child' });
}, { gamNetwork: true }));

check('actions: the chat prepares a card; nothing is changed, and the model never sees the payload', async () => withUser('admin', async ({ user, authorization, ctx }) => {
  const { executeTool, splitAction } = require('../src/ai/ask/tools');
  const forecast = require('../src/ai/forecast');
  const presetStore = require('../src/models/presetStore');
  const { accountIdFor } = require('../src/ai/accounts');
  const run = async (name, input, as = ctx) => splitAction(await executeTool(name, input, { authorization, ctx: as }));
  const fails = (name, input, pattern, as = ctx) => assert.rejects(() => executeTool(name, input, { authorization, ctx: as }), pattern);

  // a real AdSense site name, so the exact-name check is exercised against live names
  const names = JSON.parse(await executeTool('find_filter_values', { product: 'adsense', dimension: 'site' }, { authorization, ctx }));
  assert.ok(names.values.length > 0);
  const site = names.values[0];

  const save = await run('save_preset', { product: 'adsense', page: 'reporting', name: 'My Top Site', filters: { sites: [site.toUpperCase()] } });
  assert.strictEqual(save.action.type, 'save_preset');
  assert.strictEqual(save.action.presetPage, 'adsense-reporting');
  assert.deepStrictEqual(save.action.snapshot, { sites: [site] }, 'saved with the exact spelling, under the key the page uses');
  assert.strictEqual(save.action.confirm, true);
  assert.ok(!save.content.includes('__action') && !save.content.includes('presetPage'), 'the model gets no payload');
  assert.match(JSON.parse(save.content).instruction, /never say it is done/);

  // dashboard preset maps to the dashboard page id; no filters is allowed
  const plain = await run('save_preset', { product: 'admob', page: 'dashboard', name: 'Everything' });
  assert.strictEqual(plain.action.presetPage, 'admob');
  assert.deepStrictEqual(plain.action.snapshot, {});
  assert.match(plain.action.detail, /no filters/);

  await fails('save_preset', { product: 'adsense', page: 'reporting', name: 'X', filters: { sites: ['no-such-site.example'] } }, /Not found in AdSense: sites: no-such-site\.example/);
  await fails('save_preset', { product: 'adsense', page: 'reporting', name: 'X', filters: { apps: ['a'] } }, /cannot be saved with a apps filter/);
  await fails('save_preset', { product: 'adsense', page: 'roi', name: 'X' }, /dashboard or reporting/);
  await fails('save_preset', { product: 'adsense', page: 'reporting', name: '<b>x</b>' }, /cannot contain/);
  await fails('save_preset', { product: 'adsense', page: 'reporting', name: '' }, /required/);
  await fails('save_preset', { product: 'adsense', page: 'reporting', name: 'X'.repeat(41) }, /40 characters or fewer/);
  await fails('save_preset', { product: 'adsense', page: 'reporting', name: 'X' }, /Only admins/, { ...ctx, role: 'child' });

  // a name already used on that page is refused, case-insensitively
  const taken = await presetStore.putPage(user.id, 'adsense-reporting', [{ id: 'p1', name: 'Taken Name', snapshot: {}, summary: '', when: 1 }], 0);
  assert.ok(taken.ok);
  try {
    await fails('save_preset', { product: 'adsense', page: 'reporting', name: 'taken name' }, /already exists/);
  } finally {
    await db.schemaQuery(`DELETE FROM user_report_presets WHERE user_id = $1`, [user.id]);
  }

  // open_page
  const open = await run('open_page', { product: 'adsense', page: 'reporting', start_date: '2026-09-01', end_date: '2026-09-07', filters: { sites: [site] } });
  assert.deepStrictEqual([open.action.path, open.action.startDate, open.action.endDate, open.action.snapshot], ['/adsense/reporting', '2026-09-01', '2026-09-07', { sites: [site] }]);
  assert.strictEqual(open.action.confirm, false);
  assert.strictEqual((await run('open_page', { product: 'gam', page: 'roi' })).action.path, '/roi');
  assert.strictEqual((await run('open_page', { page: 'forecast' })).action.href, '/ai-forecast');
  assert.strictEqual((await run('open_page', { page: 'weekly_report' })).action.href, '/ai-report');
  await fails('open_page', { product: 'gam', page: 'dashboard', start_date: '2026-09-01' }, /both start_date and end_date/);
  await fails('open_page', { product: 'gam', page: 'dashboard', start_date: '2026-09-09', end_date: '2026-09-01' }, /must not be after/);
  await fails('open_page', { product: 'gam', page: 'dashboard', start_date: 'yesterday', end_date: '2026-09-01' }, /YYYY-MM-DD/);
  await fails('open_page', { product: 'gam', page: 'roi', filters: { sites: ['a'] } }, /only be applied when opening the dashboard or reporting/);
  await fails('open_page', { product: 'gam', page: 'nope' }, /Pages:/);
  await fails('open_page', { page: 'dashboard' }, /product is required/);

  // set_forecast_target: a proposal only
  const accountId = await accountIdFor(user);
  const before = await forecast.getTarget(accountId, 'adsense');
  const target = await run('set_forecast_target', { product: 'adsense', amount: 1234.567 });
  assert.deepStrictEqual([target.action.type, target.action.amount, target.action.confirm], ['set_forecast_target', 1234.57, true]);
  assert.strictEqual(await forecast.getTarget(accountId, 'adsense'), before, 'proposing a target saves nothing');
  assert.match((await run('set_forecast_target', { product: 'adsense', amount: 0 })).action.title, /Remove/);
  await fails('set_forecast_target', { product: 'adsense', amount: -5 }, /positive monthly target/);
  await fails('set_forecast_target', { product: 'adsense', amount: 'lots' }, /positive monthly target/);
  await fails('set_forecast_target', { product: 'adsense', amount: 5 }, /Only admins/, { ...ctx, role: 'child' });
}));

check('actions: askData collects the prepared actions, tells the screen, and hides them from the model', async () => withUser('admin', async ({ authorization, ctx }) => {
  requests.length = 0;
  const events = [];
  script = [
    toolTurn(
      ['open_page', { page: 'forecast' }],
      ['open_page', { page: 'forecast' }],
      ['set_forecast_target', { product: 'adsense', amount: 500 }]
    ),
    answer('Both are ready for you to confirm.'),
  ];
  const r = await askData({ question: 'open the forecast and set a target of 500', authorization, ctx, emit: (e, d) => events.push([e, d]) });
  assert.strictEqual(r.actions.length, 2, 'the duplicate card is dropped');
  assert.deepStrictEqual(r.actions.map((a) => a.type), ['open_page', 'set_forecast_target']);
  assert.deepStrictEqual(events.filter(([e]) => e === 'action').map(([, a]) => a.type), ['open_page', 'set_forecast_target']);
  const seen = lastToolResults();
  assert.ok(seen.every((b) => !b.is_error && !b.content.includes('__action') && /prepared_not_done/.test(b.content)));
  // an ordinary question has no actions
  script = [answer('Hello.')];
  assert.deepStrictEqual((await askData({ question: 'hi', authorization, ctx })).actions, []);
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
