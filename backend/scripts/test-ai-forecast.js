/**
 * Checks the month-end forecast: the statistics on synthetic series, then the whole flow against the local database
 * with a stand-in model (figures first, explanation after, fallback, cache, targets, alerts and the chat tool).
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
const { forecastMonth, addDays } = require('../src/ai/forecast/model');
const forecast = require('../src/ai/forecast');
const { executeTool } = require('../src/ai/ask/tools');
const alerts = require('../src/ai/alerts');

let modelCalls = 0;
let modelMode = 'ok';
provider.setClientForTests({
  messages: {
    stream(params) {
      modelCalls += 1;
      const sheet = JSON.parse(params.messages[0].content.replace('Fact sheet:\n', ''));
      const ids = Object.keys(sheet.facts);
      const json = JSON.stringify({
        headline: 'Projected to finish the month about even with last month.',
        explanation: 'Earnings so far plus the expected daily rate give the projection.',
        points: [{ text: 'P1', factIds: [ids[0], 'F9999'] }, { text: 'P2', factIds: [] }, { text: 'P3', factIds: [] }],
      });
      const h = {};
      const s = {
        on(ev, cb) { h[ev] = cb; return s; },
        async finalMessage() {
          if (modelMode === 'fail') throw new AiError('ai_timeout', 'slow', { status: 504 });
          h.text?.(json);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: json }], usage: { input_tokens: 500, output_tokens: 80 } };
        },
      };
      return s;
    },
  },
});

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** A daily series from `start` for `days` days; value(i, date) gives the day's earnings. */
function series(start, days, value) {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    return { date, value: value(i, date) };
  });
}
const dow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const near = (a, b, pct) => Math.abs(a - b) <= Math.abs(b) * pct;

// ─── the statistics ────────────────────────────────────────────────────────────

check('model: a flat month projects to the same rate, with a range around it', async () => {
  const today = '2026-09-16';
  const f = forecastMonth(series('2026-08-01', 46, () => 100), today);
  assert.ok(f.ok);
  assert.strictEqual(f.month.daysInMonth, 30);
  assert.strictEqual(f.month.elapsedDays, 15);
  assert.strictEqual(f.mtd, 1500);
  assert.strictEqual(f.remainingDays, 15);
  assert.ok(near(f.projectedEnd.mid, 3000, 0.01), `mid ${f.projectedEnd.mid}`);
  assert.ok(f.projectedEnd.low <= f.projectedEnd.mid && f.projectedEnd.mid <= f.projectedEnd.high);
  assert.ok(f.projectedEnd.low >= 1500, 'never below what is already earned');
  assert.strictEqual(f.projected.length, 15);
  assert.strictEqual(f.projected[0].date, today);
  assert.strictEqual(f.lastMonth.total, 3100);
  assert.strictEqual(f.paceVsLastMonthPct, 0);
  assert.ok(near(f.dailyLevel, 100, 0.01));
});

check('model: the weekday pattern is kept (quiet weekends project lower than weekdays)', async () => {
  const today = '2026-09-16';
  const f = forecastMonth(series('2026-07-01', 77, (i, d) => ([0, 6].includes(dow(d)) ? 50 : 120)), today);
  const weekend = f.projected.filter((p) => [0, 6].includes(dow(p.date)));
  const weekday = f.projected.filter((p) => ![0, 6].includes(dow(p.date)));
  assert.ok(weekend.length && weekday.length);
  assert.ok(weekend.every((p) => p.mid < 60) && weekday.every((p) => p.mid > 105), 'weekend ~50, weekday ~120');
  const truth = series('2026-09-16', 15, (i, d) => ([0, 6].includes(dow(d)) ? 50 : 120)).reduce((a, p) => a + p.value, 0) + f.mtd;
  assert.ok(near(f.projectedEnd.mid, truth, 0.03), `${f.projectedEnd.mid} vs ${truth}`);
});

check('model: a steep recent climb is not extrapolated into the sky', async () => {
  const today = '2026-09-16';
  // doubles every 10 days for the last 28 days
  const f = forecastMonth(series('2026-07-01', 77, (i) => (i < 49 ? 100 : 100 * 2 ** ((i - 49) / 10))), today);
  const lastDay = 100 * 2 ** (27 / 10);
  assert.ok(f.projected.every((p) => p.mid < lastDay * 1.15), 'projection stays near the latest level');
  assert.ok(Math.abs(f.slopePctPerDay) <= 0.3, `slope ${f.slopePctPerDay}%/day is capped`);
});

check('model: guards for thin, gappy or odd input', async () => {
  const today = '2026-09-16';
  const thin = forecastMonth(series('2026-09-05', 11, () => 100), today);
  assert.strictEqual(thin.ok, false);
  assert.match(thin.reason, /at least 14 days/);
  assert.strictEqual(thin.projected.length, 0);

  // zero and negative days are ignored (a failed sync is not a real zero), and today / later days never count
  const messy = series('2026-08-01', 46, () => 100);
  messy[10].value = 0;
  messy[11].value = -5;
  messy.push({ date: today, value: 99999 }, { date: '2026-09-17', value: 99999 }, { date: 'bad', value: 1 }, null);
  const f = forecastMonth(messy, today);
  assert.ok(f.ok);
  assert.ok(near(f.projectedEnd.mid, 3000, 0.02), `mid ${f.projectedEnd.mid}`);

  // history that does not reach back over last month gives no last-month comparison
  const short = forecastMonth(series('2026-09-01', 15, () => 100), '2026-09-16');
  assert.ok(short.ok === true && short.lastMonth === null && short.paceVsLastMonthPct === null);
  assert.deepStrictEqual(forecastMonth([], today).ok, false);
});

check('model: month boundaries (first day, last day, leap February)', async () => {
  const first = forecastMonth(series('2026-08-01', 62, () => 100), '2026-10-01');
  assert.strictEqual(first.month.elapsedDays, 0);
  assert.strictEqual(first.mtd, 0);
  assert.strictEqual(first.remainingDays, 31);
  assert.ok(near(first.projectedEnd.mid, 3100, 0.01));
  assert.strictEqual(first.lastMonth.total, 3000);
  assert.strictEqual(first.paceVsLastMonthPct, null, 'nothing to compare yet on day 1');

  const last = forecastMonth(series('2026-08-01', 60, () => 100), '2026-09-30');
  assert.strictEqual(last.remainingDays, 1);
  assert.strictEqual(last.month.elapsedDays, 29);

  const leap = forecastMonth(series('2028-01-01', 59, () => 100), '2028-02-29');
  assert.strictEqual(leap.month.daysInMonth, 29);
  assert.strictEqual(leap.remainingDays, 1);
});

check('model: pace against the same days last month, and the month-over-month verdict', async () => {
  const today = '2026-09-11';
  const f = forecastMonth(series('2026-08-01', 41, (i, d) => (d >= '2026-09-01' ? 200 : 100)), today);
  assert.strictEqual(f.mtd, 2000);
  assert.strictEqual(f.paceVsLastMonthPct, 100, 'twice last month\'s first 10 days');
  assert.strictEqual(forecast.judge(f, null).status, 'ahead');
  const behind = forecastMonth(series('2026-08-01', 41, (i, d) => (d >= '2026-09-01' ? 50 : 100)), today);
  assert.strictEqual(forecast.judge(behind, null).status, 'behind');
});

check('model: the 80% range holds the real outcome most of the time on noisy data', async () => {
  // deterministic pseudo-random noise (no external state)
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let inside = 0;
  let total = 0;
  for (let trial = 0; trial < 60; trial += 1) {
    const level = 100 + rand() * 400;
    const all = series('2026-06-01', 122, (i, d) => level * ([0, 6].includes(dow(d)) ? 0.6 : 1) * (1 + (rand() - 0.5) * 0.36));
    const today = '2026-09-10';
    const f = forecastMonth(all.filter((p) => p.date < today), today);
    const actual = all.filter((p) => p.date.startsWith('2026-09')).reduce((a, p) => a + p.value, 0);
    total += 1;
    if (actual >= f.projectedEnd.low && actual <= f.projectedEnd.high) inside += 1;
  }
  assert.ok(inside / total >= 0.7, `only ${inside} of ${total} outcomes were inside the range`);
});

check('judge: target statuses and last-month fallback', async () => {
  const f = { ok: true, projectedEnd: { low: 900, mid: 1000, high: 1100 }, lastMonth: { total: 1000 } };
  assert.deepStrictEqual(forecast.judge(f, 800), { status: 'will_reach', basis: 'target' });
  assert.deepStrictEqual(forecast.judge(f, 950), { status: 'on_track', basis: 'target' });
  assert.deepStrictEqual(forecast.judge(f, 1050), { status: 'at_risk', basis: 'target' });
  assert.deepStrictEqual(forecast.judge(f, 1500), { status: 'will_miss', basis: 'target' });
  assert.deepStrictEqual(forecast.judge(f, null), { status: 'similar', basis: 'last_month' });
  assert.deepStrictEqual(forecast.judge({ ...f, lastMonth: null }, null), { status: 'unknown', basis: null });
  assert.deepStrictEqual(forecast.judge({ ok: false }, 100), { status: 'unknown', basis: null });
});

// ─── the whole flow, on the local database ─────────────────────────────────────

async function withAdmin(fn, { role = 'admin', gamNetwork = false } = {}) {
  await db.schemaQuery(`CREATE TABLE IF NOT EXISTS ai_forecast_targets (
    account_id TEXT NOT NULL, product TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (account_id, product))`);
  const { rows } = await db.schemaQuery(
    gamNetwork
      ? `SELECT u.client_id AS id FROM users u JOIN user_report_presets p ON p.user_id = u.id WHERE u.client_id IS NOT NULL LIMIT 1`
      : `SELECT c.publisher_parent_id AS id FROM gam_clients c JOIN adsense_accounts a ON a.client_id = c.id
         WHERE c.publisher_parent_id IS NOT NULL LIMIT 1`
  );
  const id = `user-aitest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  let accountId = null;
  try {
    await createUser({ id, username: `aitest_${id.slice(-8)}`, password: 'Test#12345x', role, permissions: {}, clientId: rows[0]?.id });
    const sid = await rotateUserSession(id, {});
    const user = await getUserById(id);
    const { accessToken } = generateTokens(user, sid);
    accountId = await alerts.accountIdFor(user);
    await fn({ user, authorization: `Bearer ${accessToken}`, ctx: { userId: id, clientId: user.clientId, role: user.role }, accountId });
  } finally {
    await deleteUser(id).catch(() => {});
    if (accountId) {
      await db.schemaQuery('DELETE FROM ai_forecast_targets WHERE account_id = $1', [String(accountId)]).catch(() => {});
      await db.schemaQuery(`DELETE FROM ai_alerts WHERE account_id = $1 AND signal_kind = 'forecast_miss'`, [String(accountId)]).catch(() => {});
    }
    await db.schemaQuery('DELETE FROM ai_usage_log WHERE user_id = $1', [id]).catch(() => {});
  }
}

check('forecast: figures first, explanation after; facts are cited; invented ids are dropped; reused when nothing changed', async () => withAdmin(async ({ authorization, ctx }) => {
  const events = [];
  const r = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' }, emit: (e) => events.push(e) });
  assert.deepStrictEqual(events, ['figures', 'result']);
  assert.strictEqual(r.figures.ok, true, r.figures.reason);
  assert.strictEqual(r.meta.source, 'ai');
  assert.ok(!JSON.stringify(r).includes('F9999'));
  const f = r.figures;
  assert.ok(f.projectedEnd.low <= f.projectedEnd.mid && f.projectedEnd.mid <= f.projectedEnd.high);
  assert.ok(f.projectedEnd.mid >= f.mtd, 'the projection includes what is already earned');
  assert.ok(Math.abs(f.mtd + f.remainingMid - f.projectedEnd.mid) < 0.05, 'earned so far + still to come = projection');
  assert.ok(f.projected.length === f.remainingDays && f.actual.length > 0);
  assert.ok(r.points.some((p) => p.factIds.length), 'the points cite facts');
  assert.ok(Object.values(r.facts).every((x) => x.display));

  const before = modelCalls;
  await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' } });
  assert.strictEqual(modelCalls, before, 'the same figures reuse the stored explanation');
}));

check('forecast: Google Ad Manager reads the warehouse rollup for the admin\'s network', async () => withAdmin(async ({ authorization, ctx }) => {
  const r = await forecast.forecastProduct({ authorization, ctx, body: { product: 'gam' } });
  assert.strictEqual(r.figures.label, 'Google Ad Manager');
  assert.strictEqual(r.figures.ok, true, r.figures.reason);
  assert.strictEqual(r.figures.currency, 'USD');
  assert.ok(r.figures.lastMonth && r.figures.lastMonth.total > 0, 'last month is available');
}, { gamNetwork: true }));

check('forecast: a failing model falls back to the rule-based explanation', async () => withAdmin(async ({ authorization, ctx }) => {
  modelMode = 'fail';
  try {
    const r = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' }, emit: () => {} });
    // an earlier check may have stored today's explanation; force a different sheet with a target
    await forecast.setTarget({ ctx, product: 'adsense', amount: 123456 });
    const r2 = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' } });
    assert.ok([r.meta.source, r2.meta.source].includes('rules'));
    assert.strictEqual(r2.meta.source, 'rules');
    assert.strictEqual(r2.meta.error.code, 'ai_timeout');
    assert.match(r2.headline, /projected to finish/);
    assert.ok(r2.points.length >= 1 && r2.points.some((p) => /target/.test(p.text)));
  } finally {
    modelMode = 'ok';
  }
}));

check('targets: set, change the verdict, clear; bad values and products are refused', async () => withAdmin(async ({ authorization, ctx, accountId }) => {
  assert.strictEqual(await forecast.getTarget(accountId, 'adsense'), null);
  const base = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' } });
  const { mid, low } = base.figures.projectedEnd;

  // below the low end of the range (the range is wide on volatile data, so use the low end, not the middle)
  const easy = Math.max(Math.round(low * 0.5 * 100) / 100, 0.01);
  await forecast.setTarget({ ctx, product: 'adsense', amount: easy });
  let r = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' } });
  assert.strictEqual(r.figures.status, 'will_reach');
  assert.strictEqual(r.figures.basis, 'target');
  assert.strictEqual(r.figures.target, easy);

  await forecast.setTarget({ ctx, product: 'adsense', amount: mid * 5 });
  r = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' } });
  assert.strictEqual(r.figures.status, 'will_miss');

  await forecast.setTarget({ ctx, product: 'adsense', amount: 0 });
  assert.strictEqual(await forecast.getTarget(accountId, 'adsense'), null);
  r = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' } });
  assert.strictEqual(r.figures.target, null);
  assert.strictEqual(r.figures.basis, 'last_month');

  await assert.rejects(() => forecast.setTarget({ ctx, product: 'adsense', amount: -5 }), /positive/);
  await assert.rejects(() => forecast.setTarget({ ctx, product: 'adsense', amount: 'abc' }), /positive/);
  await assert.rejects(() => forecast.setTarget({ ctx, product: 'nope', amount: 5 }), /Unknown product/);
  await assert.rejects(() => forecast.forecastProduct({ authorization, ctx, body: { product: 'nope' } }), /Unknown product/);
}));

check('alerts: a month likely to miss its target raises one alert, and not twice in a row', async () => withAdmin(async ({ user, authorization, ctx, accountId }) => {
  assert.deepStrictEqual(await forecast.forecastAlerts({ authorization, ctx }), [], 'no target, no alert');
  const base = await forecast.forecastProduct({ authorization, ctx, body: { product: 'adsense' } });
  await forecast.setTarget({ ctx, product: 'adsense', amount: base.figures.projectedEnd.high * 3 });
  const list = await forecast.forecastAlerts({ authorization, ctx });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].severity, 'critical');
  assert.match(list[0].title, /AdSense may miss its .* target/);
  assert.ok(list[0].key.endsWith(base.figures.month.start));

  await alerts.scanAccount({ user, authorization });
  const { rows } = await db.schemaQuery(`SELECT title, severity FROM ai_alerts WHERE account_id = $1 AND signal_kind = 'forecast_miss'`, [String(accountId)]);
  assert.strictEqual(rows.length, 1);
  await alerts.scanAccount({ user, authorization });
  const again = await db.schemaQuery(`SELECT 1 FROM ai_alerts WHERE account_id = $1 AND signal_kind = 'forecast_miss'`, [String(accountId)]);
  assert.strictEqual(again.rows.length, 1, 'quiet for a week after it was raised');
}));

check('chat tool: get_forecast returns compact figures and refuses bad input and non-admins', async () => withAdmin(async ({ authorization, ctx }) => {
  const out = JSON.parse(await executeTool('get_forecast', { product: 'AdSense' }, { authorization, ctx }));
  assert.strictEqual(out.product, 'AdSense');
  assert.ok(out.projected_month_end && out.likely_range && out.earned_so_far);
  assert.match(out.note, /not a promise/);
  await assert.rejects(() => executeTool('get_forecast', { product: 'nope' }, { authorization, ctx }), /product must be one of/);
  await assert.rejects(() => executeTool('get_forecast', { product: 'gam' }, { authorization, ctx: { ...ctx, role: 'child' } }), /available to admins/);
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
