/**
 * Centralised, timezone-aware date helpers.
 *
 * All report date boundaries ("today", ranges) are computed in APP_TIMEZONE
 * (default Asia/Singapore) so the dashboard reflects the Singapore business day
 * regardless of where the server runs.
 *
 * Override with the APP_TIMEZONE env var (any IANA zone, e.g. "Asia/Kolkata").
 */
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Singapore';

// 'YYYY-MM-DD' for the given Date as seen in APP_TIMEZONE (en-CA → ISO-like).
function ymdInTZ(date = new Date(), tz = APP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

// Current calendar date in APP_TIMEZONE as 'YYYY-MM-DD'.
function todayInTZ(tz = APP_TIMEZONE) {
  return ymdInTZ(new Date(), tz);
}

/** Current hour (0–23) in APP_TIMEZONE. */
function hourInTZ(date = new Date(), tz = APP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  return parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
}

/** True during the last hourly cron slot of the business day (23:00–23:59). */
function isLastHourOfDay(tz = APP_TIMEZONE) {
  return hourInTZ(new Date(), tz) === 23;
}

// Shift a 'YYYY-MM-DD' string by a number of calendar days (can be negative).
function shiftYMD(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// First day of the month for a 'YYYY-MM-DD' string.
function startOfMonth(ymd) {
  const [y, m] = ymd.split('-');
  return `${y}-${m}-01`;
}

/** First day of the previous calendar month for a 'YYYY-MM-DD' string. */
function startOfPreviousMonth(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  const prev = m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
  return `${prev.year}-${String(prev.month).padStart(2, '0')}-01`;
}

/** Last day of the previous calendar month for a 'YYYY-MM-DD' string. */
function endOfPreviousMonth(ymd) {
  const thisMonthStart = startOfMonth(ymd);
  return shiftYMD(thisMonthStart, -1);
}

/** Last day of the calendar month containing `ymd`. */
function endOfMonth(ymd) {
  const start = startOfMonth(ymd);
  const [y, m] = start.split('-').map(Number);
  const next = m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 };
  const nextStart = `${next.year}-${String(next.month).padStart(2, '0')}-01`;
  return shiftYMD(nextStart, -1);
}

/**
 * Calendar-month windows in [startDate, endDate], newest month first.
 * Example: Aug 2026 → Jul 2026 → Jun 2026.
 */
function listCalendarMonthsNewestFirst(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return [];
  const months = [];
  let cursor = startOfMonth(endDate);
  const firstMonth = startOfMonth(startDate);
  while (cursor >= firstMonth) {
    const monthEnd = endOfMonth(cursor);
    const from = cursor < startDate ? startDate : cursor;
    const to = monthEnd > endDate ? endDate : monthEnd;
    months.push({ startDate: from, endDate: to });
    cursor = startOfMonth(shiftYMD(cursor, -1));
  }
  return months;
}

/**
 * Inclusive date windows, newest first. Caps GAM CSV size so a month
 * of ~2.5M grain rows is never parsed as one in-memory array.
 */
function listDateWindowsNewestFirst(startDate, endDate, maxDays = 7) {
  const span = Math.max(1, parseInt(maxDays, 10) || 7);
  if (!startDate || !endDate || startDate > endDate) return [];
  const windows = [];
  let to = endDate;
  while (to >= startDate) {
    const from = shiftYMD(to, -(span - 1));
    windows.push({
      startDate: from < startDate ? startDate : from,
      endDate: to,
    });
    to = shiftYMD(from < startDate ? startDate : from, -1);
  }
  return windows;
}

/**
 * Past-data window stored in report_daily.
 * HISTORICAL_DAYS (default 365) back from yesterday, at least previous calendar month.
 * Today stays in report_present.
 */
function historicalRangeForPresets(tz = APP_TIMEZONE) {
  const today = todayInTZ(tz);
  const endDate = shiftYMD(today, -1); // yesterday
  const days = Math.max(31, parseInt(process.env.HISTORICAL_DAYS || '365', 10) || 365);
  let startDate = shiftYMD(today, -days);
  const minStart = startOfPreviousMonth(today);
  if (startDate > minStart) startDate = minStart;
  return {
    today,
    yesterday: endDate,
    startDate,
    endDate,
    last7Start: shiftYMD(today, -7),
    last30Start: shiftYMD(today, -30),
    thisMonthStart: startOfMonth(today),
    lastMonthStart: startOfPreviousMonth(today),
    lastMonthEnd: endOfPreviousMonth(today),
  };
}

function ymdToObj(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return { year, month, day };
}

function objToYmd({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// { startDate, endDate } objects (year/month/day) for the last `days` days,
// anchored on "today" in APP_TIMEZONE — drop-in replacement for the old helper.
function dateRangeInTZ(days, tz = APP_TIMEZONE) {
  const endYMD = todayInTZ(tz);
  const startYMD = shiftYMD(endYMD, -parseInt(days, 10));
  return { startDate: ymdToObj(startYMD), endDate: ymdToObj(endYMD) };
}

/** Same as dateRangeInTZ but returns 'YYYY-MM-DD' strings for report builders. */
function dateRangeYMDInTZ(days, tz = APP_TIMEZONE) {
  const endYMD = todayInTZ(tz);
  const startYMD = shiftYMD(endYMD, -parseInt(days, 10));
  return { startDate: startYMD, endDate: endYMD };
}

module.exports = {
  APP_TIMEZONE,
  ymdInTZ,
  todayInTZ,
  hourInTZ,
  isLastHourOfDay,
  shiftYMD,
  startOfMonth,
  startOfPreviousMonth,
  endOfPreviousMonth,
  endOfMonth,
  listCalendarMonthsNewestFirst,
  listDateWindowsNewestFirst,
  historicalRangeForPresets,
  ymdToObj,
  objToYmd,
  dateRangeInTZ,
  dateRangeYMDInTZ,
};
