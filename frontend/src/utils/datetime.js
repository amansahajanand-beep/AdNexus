/**
 * Timezone-aware date helpers (frontend).
 * Everything is computed in APP_TIMEZONE (Asia/Singapore) so the date pickers,
 * presets and "last updated" labels all follow the Singapore business day.
 */
export const APP_TIMEZONE = 'Asia/Singapore';

// 'YYYY-MM-DD' for a Date as seen in APP_TIMEZONE (en-CA → ISO-like).
export function ymdInTZ(date = new Date(), tz = APP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

export function todayInTZ(tz = APP_TIMEZONE) {
  return ymdInTZ(new Date(), tz);
}

export function shiftYMD(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

export function startOfMonth(ymd) {
  const [y, m] = ymd.split('-');
  return `${y}-${m}-01`;
}

// { startDate, endDate } for a named preset, anchored on "today" in Singapore (or opts.timeZone).
// opts.includeToday — when true, historical presets end on today instead of yesterday.
// opts.timeZone — IANA zone (AdMob accounts often Asia/Calcutta; GAM uses APP_TIMEZONE).
export function presetRange(preset, opts = {}) {
  const tz = opts.timeZone || APP_TIMEZONE;
  const today = todayInTZ(tz);
  const yesterday = shiftYMD(today, -1);
  const includeToday = opts.includeToday === true;
  const histEnd = includeToday ? today : yesterday;
  if (preset === 'yesterday') {
    return { startDate: yesterday, endDate: yesterday };
  }
  if (preset === 'today') return { startDate: today, endDate: today };
  // Historical presets: default ends on yesterday (AdMob console Last 7 does the same).
  if (preset === 'last7') return { startDate: shiftYMD(histEnd, -6), endDate: histEnd };
  if (preset === 'last30') return { startDate: shiftYMD(histEnd, -29), endDate: histEnd };
  if (preset === 'lastMonth') {
    const [y, m] = today.split('-').map(Number);
    const lastM = m === 1 ? 12 : m - 1;
    const lastY = m === 1 ? y - 1 : y;
    const start = `${lastY}-${String(lastM).padStart(2, '0')}-01`;
    const end = shiftYMD(`${y}-${String(m).padStart(2, '0')}-01`, -1);
    return { startDate: start, endDate: end };
  }
  // thisMonth: month start through histEnd
  if (preset === 'thisMonth') {
    return { startDate: startOfMonth(today), endDate: histEnd };
  }
  return { startDate: startOfMonth(today), endDate: histEnd };
}

export function thisMonthRange() {
  return presetRange('thisMonth');
}

// Current time-of-day in Singapore, e.g. "10:42:05" (for "Updated …" labels).
export function nowTimeInTZ(tz = APP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());
}
