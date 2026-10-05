/**
 * Month-end earnings forecast. Plain statistics, no model call: the AI only explains the result.
 *
 * Method, chosen to be predictable and explainable:
 *   1. Weekday pattern: each weekday's average against the overall average over the last 8 weeks.
 *   2. Remove that pattern from the last 28 days, then fit a recency-weighted straight line.
 *   3. Continue the line forward with the slope damped (trends fade; they do not run forever) and put the
 *      weekday pattern back.
 *   4. The uncertainty comes from how far the last 28 days scattered around the line, plus the uncertainty of
 *      the level and the slope. The range shown is an 80% interval.
 * Days are complete days (up to yesterday); today and later are projected.
 */

const Z80 = 1.2816;
const FIT_DAYS = 28;
const PATTERN_DAYS = 56;
const MIN_POINTS = 14;
// Tuned by replaying three past months of a real network (forecast made every second day, compared with the
// month's final total): typical error 6.6%, against 6.8% for a plain "daily average so far x days in the month".
// Trends in daily earnings proved weak and noisy, so the slope is small and fades fast. Daily earnings drift in
// runs (a good week stays good), so the plain statistical band was too narrow (55% of outcomes inside the nominal
// 80% band); the width factor below brings it to 79%.
const DAMPING = 0.8;
const MAX_SLOPE_PER_DAY = 0.003; // of the current level
const MIN_SCATTER = 0.03;
const LEVEL_EFFECTIVE_POINTS = 3;
const WIDEN = 2.2;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const round = (v, d = 2) => Number(Number(v).toFixed(d));

const toDate = (ymd) => new Date(`${ymd}T00:00:00Z`);
const toYmd = (d) => d.toISOString().slice(0, 10);
const addDays = (ymd, n) => toYmd(new Date(toDate(ymd).getTime() + n * 86400000));
const weekday = (ymd) => toDate(ymd).getUTCDay();
const daysInMonth = (ymd) => new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)), 0)).getUTCDate();

function monthBounds(ymd) {
  const start = `${ymd.slice(0, 8)}01`;
  return { start, end: `${ymd.slice(0, 8)}${String(daysInMonth(ymd)).padStart(2, '0')}` };
}

function previousMonthBounds(ymd) {
  const start = `${ymd.slice(0, 8)}01`;
  const prevEnd = addDays(start, -1);
  return monthBounds(prevEnd);
}

/** Each weekday's average against the overall average; weekdays with too little data stay at 1. */
function weekdayFactors(points) {
  const recent = points.slice(-PATTERN_DAYS);
  const overall = mean(recent.map((p) => p.value));
  const factors = Array(7).fill(1);
  if (!(overall > 0)) return factors;
  const raw = Array(7).fill(null);
  for (let d = 0; d < 7; d += 1) {
    const vals = recent.filter((p) => weekday(p.date) === d).map((p) => p.value);
    if (vals.length >= 3) raw[d] = mean(vals) / overall;
  }
  const known = raw.filter((v) => v != null);
  if (known.length < 7) return factors; // a partial pattern would bias every other weekday
  const norm = mean(known);
  return raw.map((v) => Math.min(1.8, Math.max(0.4, v / norm)));
}

/** Weighted straight line through (i - last, y): returns the level at the last point and the slope per day. */
function fitLine(ys) {
  const n = ys.length;
  const w = ys.map((_, i) => 0.95 ** (n - 1 - i));
  const x = ys.map((_, i) => i - (n - 1));
  const sw = w.reduce((a, b) => a + b, 0);
  const mx = w.reduce((a, wi, i) => a + wi * x[i], 0) / sw;
  const my = w.reduce((a, wi, i) => a + wi * ys[i], 0) / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += w[i] * (x[i] - mx) ** 2;
    sxy += w[i] * (x[i] - mx) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { level: my + slope * (0 - mx), slope };
}

/**
 * @param {{date: string, value: number}[]} series  complete days in order, up to yesterday
 * @param {string} today                            YYYY-MM-DD in the reporting time zone
 */
function forecastMonth(series, today, opts = {}) {
  // Overridable so the settings can be tuned against past months (see test-ai-forecast.js).
  const damping = opts.damping ?? DAMPING;
  const maxSlope = opts.maxSlopePerDay ?? MAX_SLOPE_PER_DAY;
  const levelN = opts.levelEffectivePoints ?? LEVEL_EFFECTIVE_POINTS;
  const widen = opts.widen ?? WIDEN;
  const { start: monthStart, end: monthEnd } = monthBounds(today);
  const clean = (series || [])
    .filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(Number(p.value)) && p.date < today)
    .map((p) => ({ date: p.date, value: Number(p.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const positive = clean.filter((p) => p.value > 0);

  const mtdPoints = clean.filter((p) => p.date >= monthStart);
  const mtd = mtdPoints.reduce((a, p) => a + p.value, 0);
  const prevBounds = previousMonthBounds(today);
  const prevPoints = clean.filter((p) => p.date >= prevBounds.start && p.date <= prevBounds.end);
  const prevCovered = clean.length > 0 && clean[0].date <= prevBounds.start;
  const lastMonthTotal = prevPoints.reduce((a, p) => a + p.value, 0);
  const elapsed = mtdPoints.length;
  const lastMonthSamePoint = prevPoints.filter((p) => Number(p.date.slice(8)) <= elapsed).reduce((a, p) => a + p.value, 0);

  const base = {
    month: { start: monthStart, end: monthEnd, today, elapsedDays: elapsed, daysInMonth: daysInMonth(today) },
    mtd: round(mtd),
    lastMonth: prevCovered && lastMonthTotal > 0 ? { total: round(lastMonthTotal), start: prevBounds.start, end: prevBounds.end } : null,
    // Needs a few days on both sides: one or two days against last month's first days says little.
    paceVsLastMonthPct: prevCovered && elapsed >= 3 && lastMonthSamePoint > 0 ? round(((mtd - lastMonthSamePoint) / lastMonthSamePoint) * 100, 1) : null,
  };

  if (positive.length < MIN_POINTS) {
    return { ...base, ok: false, reason: `Needs at least ${MIN_POINTS} days of earnings to forecast; there are ${positive.length}.`, actual: clean.slice(-31), projected: [] };
  }

  const factors = weekdayFactors(positive);
  const fitPoints = positive.slice(-FIT_DAYS);
  const deseason = fitPoints.map((p) => p.value / factors[weekday(p.date)]);
  const { level, slope } = fitLine(deseason);
  const levelNow = Math.max(level, 0);
  const slopeUsed = levelNow > 0 ? Math.max(-maxSlope * levelNow, Math.min(maxSlope * levelNow, slope)) : 0;

  // how far the recent days scatter around the fitted line, as a fraction of the line
  const n = deseason.length;
  const rel = deseason.map((d, i) => {
    const fitted = level + slope * (i - (n - 1));
    return fitted > 0 ? (d - fitted) / fitted : 0;
  });
  const scatter = Math.max(std(rel), MIN_SCATTER);

  const remainingDates = [];
  for (let d = today; d <= monthEnd; d = addDays(d, 1)) remainingDates.push(d);

  let trendSum = 0;
  let damp = 1;
  let sumMid = 0;
  let sumVar = 0;
  let sumKf = 0;
  const projected = remainingDates.map((date, i) => {
    const k = i + 1;
    damp *= damping;
    trendSum += slopeUsed * damp;
    const f = factors[weekday(date)];
    const mid = Math.max(0, levelNow + trendSum) * f;
    const sdNoise = scatter * mid;
    const sdLevel = (scatter / Math.sqrt(levelN)) * mid;
    const sdTrend = 0.5 * Math.abs(slopeUsed) * k * f;
    const sd = Math.sqrt(sdNoise ** 2 + sdLevel ** 2 + sdTrend ** 2);
    sumMid += mid;
    sumVar += sdNoise ** 2;
    sumKf += k * f;
    return { date, mid: round(mid), low: round(Math.max(0, mid - Z80 * widen * sd)), high: round(mid + Z80 * widen * sd) };
  });
  const levelSd = (scatter / Math.sqrt(levelN)) * sumMid;
  const trendSd = 0.5 * Math.abs(slopeUsed) * sumKf;
  const totalSd = Math.sqrt(sumVar + levelSd ** 2 + trendSd ** 2);

  const last7 = positive.slice(-7).reduce((a, p) => a + p.value, 0);
  const prev7 = positive.slice(-14, -7).reduce((a, p) => a + p.value, 0);

  return {
    ...base,
    ok: true,
    projectedEnd: {
      mid: round(mtd + sumMid),
      low: round(mtd + Math.max(0, sumMid - Z80 * widen * totalSd)),
      high: round(mtd + sumMid + Z80 * widen * totalSd),
    },
    remainingDays: remainingDates.length,
    remainingMid: round(sumMid),
    weekdayFactors: factors.map((f) => round(f, 3)),
    dailyLevel: round(levelNow),
    slopePctPerDay: levelNow > 0 ? round((slopeUsed / levelNow) * 100, 2) : 0,
    scatterPct: round(scatter * 100, 1),
    weekOverWeekPct: prev7 > 0 ? round(((last7 - prev7) / prev7) * 100, 1) : null,
    actual: clean.slice(-31),
    projected,
  };
}

module.exports = { forecastMonth, monthBounds, addDays, weekdayFactors, fitLine, Z80 };
