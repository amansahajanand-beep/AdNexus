/**
 * Checks the Dashboard timezone view against the local database.
 *
 *   node scripts/test-timezone-view.js
 *
 * The regrouping is verified by an independent calculation in JavaScript over the same stored hours.
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';

const assert = require('assert');
const db = require('../src/db');
const hv = require('../src/services/hourlyView');
const { shiftYMD, ymdInTZ } = require('../src/utils/datetime');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const HOUR = 3600000;

check('wall clock -> instant, including daylight-saving days', async () => {
  const z = (ymd, h, tz) => new Date(hv.wallToInstant(ymd, h, tz)).toISOString();
  assert.strictEqual(z('2026-10-06', 0, 'Asia/Singapore'), '2026-10-05T16:00:00.000Z');
  assert.strictEqual(z('2026-10-07', 0, 'Asia/Kolkata'), '2026-10-06T18:30:00.000Z');
  // US fall back (1 Nov 2026): midnight is still summer time, 02:00 is winter time.
  assert.strictEqual(z('2026-11-01', 0, 'America/New_York'), '2026-11-01T04:00:00.000Z');
  assert.strictEqual(z('2026-11-01', 2, 'America/New_York'), '2026-11-01T07:00:00.000Z');
  // US spring forward (8 Mar 2026): 01:00 is winter time, 03:00 is summer time (one real hour later).
  assert.strictEqual(z('2026-03-08', 1, 'America/New_York'), '2026-03-08T06:00:00.000Z');
  assert.strictEqual(z('2026-03-08', 3, 'America/New_York'), '2026-03-08T07:00:00.000Z');
  assert.strictEqual(new Date(hv.localMidnight('2026-10-07', 'Australia/Sydney')).toISOString(), '2026-10-06T13:00:00.000Z');
});

check('picker starts from the network zone and flags half-hour zones', async () => {
  const us = hv.timezoneOptions('America/New_York');
  assert.strictEqual(us[0].id, 'America/New_York');
  assert.match(us[0].label, /New York \(network\)/);
  assert.ok(!us.slice(1).some((o) => o.id === 'America/New_York'), 'the network zone is not listed twice');
  assert.ok(us.some((o) => o.id === 'Asia/Singapore'), 'Singapore is offered when it is not the network zone');
  assert.strictEqual(us.find((o) => o.id === 'Asia/Kolkata').approx, true);
  const sg = hv.timezoneOptions('Asia/Singapore');
  assert.ok(!sg.slice(1).some((o) => o.id === 'Asia/Singapore'));
  assert.strictEqual(sg.find((o) => o.id === 'Asia/Tokyo').approx, false);
});

async function pickClient() {
  const { rows } = await db.schemaQuery(
    `SELECT client_id FROM rollup_hourly WHERE kind = 'network' GROUP BY client_id ORDER BY COUNT(*) DESC LIMIT 1`
  );
  return rows[0]?.client_id || null;
}

async function storedHours(clientId, srcTz) {
  const { rows } = await db.schemaQuery(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS day, hour, revenue::float8 AS revenue
     FROM rollup_hourly WHERE client_id = $1::uuid AND kind = 'network'`,
    [clientId]
  );
  return rows.map((r) => ({ inst: hv.wallToInstant(r.day, Number(r.hour), srcTz), revenue: r.revenue }));
}

/** Revenue of local days [d1, d2] in `tz`, computed in JavaScript with each stored hour split into two half hours. */
function expected(hours, tz, d1, d2) {
  let sum = 0;
  for (const h of hours) {
    for (const off of [0, 30 * 60000]) {
      const ld = ymdInTZ(new Date(h.inst + off), tz);
      if (ld >= d1 && ld <= d2) sum += h.revenue / 2;
    }
  }
  return sum;
}

for (const [label, srcTz, tz] of [
  ['Singapore network viewed in India (half-hour zone)', 'Asia/Singapore', 'Asia/Kolkata'],
  ['Singapore network viewed in New York', 'Asia/Singapore', 'America/New_York'],
  ['a US-timezone network viewed in Singapore', 'America/New_York', 'Asia/Singapore'],
  ['a US-timezone network viewed in India', 'America/New_York', 'Asia/Kolkata'],
]) {
  check(`regrouped days match an independent calculation: ${label}`, async () => {
    const clientId = await pickClient();
    if (!clientId) return;
    const today = ymdInTZ(new Date(), tz);
    const cov = await hv.coverage(clientId, tz, today, srcTz);
    assert.ok(cov, 'some days are covered');
    // use the last 5 local days that are fully inside the covered range
    const end = cov.partialDay === cov.through ? shiftYMD(cov.through, -1) : cov.through;
    const start = shiftYMD(end, -4);
    assert.ok(start >= cov.from, `range ${start}..${end} starts inside coverage from ${cov.from}`);
    const view = await hv.buildHourlyView({ clientId, startDate: start, endDate: end, tz, srcTz });
    const got = view.trend.reduce((a, d) => a + d.earning, 0);
    const want = expected(await storedHours(clientId, srcTz), tz, start, end);
    assert.ok(Math.abs(got - want) < 0.5, `sum ${got.toFixed(2)} vs expected ${want.toFixed(2)}`);
    // per-day figures agree too
    for (const d of view.trend) {
      const w = expected(await storedHours(clientId, srcTz), tz, d.date, d.date);
      assert.ok(Math.abs(d.earning - w) < 0.5, `${d.date}: ${d.earning} vs ${w.toFixed(2)}`);
    }
  });
}

check('a day that is still filling counts (today in another zone), and a lagging sync does not', async () => {
  const clientId = await pickClient();
  if (!clientId) return;
  const srcTz = 'Asia/Singapore';
  const { rows: [last] } = await db.schemaQuery(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS day, hour FROM rollup_hourly
     WHERE client_id = $1::uuid AND kind = 'network' ORDER BY report_date DESC, hour DESC LIMIT 1`,
    [clientId]
  );
  const newestEnd = hv.wallToInstant(last.day, Number(last.hour), srcTz) + HOUR;
  const tz = 'America/New_York';
  const today = ymdInTZ(new Date(newestEnd), tz);

  // right after the newest stored hour the sync is "fresh": the current New York day is partial but served
  const fresh = await hv.coverage(clientId, tz, today, srcTz, newestEnd + 30 * 60000);
  assert.strictEqual(fresh.through, ymdInTZ(new Date(newestEnd - 1), tz));
  assert.ok(fresh.partialDay === null || fresh.partialDay === fresh.through);

  // a day later the sync is lagging: the unfinished day is dropped, only complete days remain
  const stale = await hv.coverage(clientId, tz, today, srcTz, newestEnd + 30 * HOUR);
  assert.ok(stale.through < fresh.through || stale.partialDay === null);
  assert.strictEqual(stale.partialDay, null);
});

check('partial current day in another zone = the hours since that zone\'s midnight', async () => {
  const clientId = await pickClient();
  if (!clientId) return;
  const srcTz = 'Asia/Singapore';
  const tz = 'America/New_York';
  const hours = await storedHours(clientId, srcTz);
  const newestEnd = Math.max(...hours.map((h) => h.inst)) + HOUR;
  const day = ymdInTZ(new Date(newestEnd - 1), tz);
  const view = await hv.buildHourlyView({ clientId, startDate: day, endDate: day, tz, srcTz });
  const got = view.trend[0]?.earning || 0;
  const mid = hv.localMidnight(day, tz);
  const want = hours.filter((h) => h.inst >= mid).reduce((a, h) => a + h.revenue, 0);
  assert.ok(Math.abs(got - want) < 0.5, `${got} vs ${want.toFixed(2)}`);
  assert.ok(got > 0, 'there is revenue for the partial day');
});

check('a network with a stored timezone is used as-is; an unreadable one falls back to the app timezone', async () => {
  const { getNetworkTz } = require('../src/services/networkTimezone');
  const { APP_TIMEZONE } = require('../src/utils/datetime');
  assert.strictEqual(await getNetworkTz({ id: 'x', timeZone: 'America/Chicago' }), 'America/Chicago');
  assert.strictEqual(await getNetworkTz({ id: 'x', timeZone: 'Not/AZone' }), APP_TIMEZONE, 'no credentials: fallback');
  assert.strictEqual(await getNetworkTz(null), APP_TIMEZONE);
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
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
