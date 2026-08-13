/**
 * Shared chart axis helpers — keep full datasets; only thin visible ticks / compact labels.
 */

/** Compact axis tick for money (avoids US$1,000,000.00 clipping). Tooltips can stay full. */
export function formatAxisMoney(value, currency = 'USD') {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const sym = currency === 'USD' || !currency ? '$' : '';
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${sign}${sym}${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 100) return `${sign}${sym}${Math.round(abs)}`;
  if (abs >= 10) return `${sign}${sym}${abs.toFixed(1)}`;
  return `${sign}${sym}${abs.toFixed(2)}`;
}

export function formatAxisNumber(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(abs).toLocaleString()}`;
}

export function formatAxisMetric(value, format, currency = 'USD') {
  if (format === 'money') return formatAxisMoney(value, currency);
  if (format === 'percent') {
    const n = Number(value) || 0;
    const pct = n > 0 && n <= 1 ? n * 100 : n;
    return `${pct.toFixed(0)}%`;
  }
  return formatAxisNumber(value);
}

/** Left margin / YAxis width so compact ticks never clip. */
export function yAxisWidthForValues(values = [], format = 'raw', { isNarrow = false } = {}) {
  const sample = (values.length ? values : [0])
    .map((v) => formatAxisMetric(v, format, 'USD'))
    .sort((a, b) => b.length - a.length)[0] || '$0';
  const approx = Math.ceil(sample.length * (isNarrow ? 7.2 : 7.8)) + 10;
  const min = isNarrow ? 44 : 52;
  const max = isNarrow ? 72 : 88;
  return Math.min(max, Math.max(min, approx));
}

function parseDateParts(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short date label based on series length (data unchanged). */
export function formatDateTick(raw, pointCount = 0) {
  const p = parseDateParts(raw);
  if (!p) return String(raw || '');
  const mon = MONTHS[p.mo - 1] || String(p.mo);
  if (pointCount > 120) return mon; // year-ish → month only
  if (pointCount > 45) return `${mon}`; // multi-month → month
  if (pointCount > 14) return `${mon} ${p.d}`;
  return `${mon} ${p.d}`;
}

/**
 * Recharts XAxis interval: 0 = every tick; N = show every (N+1)th.
 * Keeps ~5–8 labels on narrow, ~6–12 on desktop.
 */
export function dateTickInterval(pointCount, { isNarrow = false } = {}) {
  const n = Math.max(0, Number(pointCount) || 0);
  if (n <= 7) return 0;
  const target = isNarrow ? 5 : (n > 180 ? 8 : n > 60 ? 8 : 10);
  return Math.max(0, Math.ceil(n / target) - 1);
}

export function dateAxisProps(pointCount, { isNarrow = false } = {}) {
  const n = Math.max(0, Number(pointCount) || 0);
  const angled = isNarrow ? n > 5 : n > 14;
  const interval = dateTickInterval(n, { isNarrow });
  return {
    interval,
    minTickGap: isNarrow ? 22 : 14,
    angle: angled ? -35 : 0,
    textAnchor: angled ? 'end' : 'middle',
    height: angled ? (isNarrow ? 48 : 52) : 30,
    tickMargin: angled ? 6 : 4,
    tickFormatter: (v) => formatDateTick(v, n),
    tick: { fontSize: isNarrow ? 9 : 11 },
    tickLine: false,
    axisLine: false,
  };
}

/** Chart margins that leave room for Y ticks + angled X labels. */
export function chartMargins({ isNarrow = false, hasAngledX = false, yWidth = 56 } = {}) {
  const leftPad = Math.max(4, yWidth - (isNarrow ? 40 : 48));
  return {
    top: 10,
    right: isNarrow ? 10 : 18,
    left: Math.min(isNarrow ? 8 : 12, leftPad),
    bottom: hasAngledX ? (isNarrow ? 36 : 28) : 8,
  };
}

/** Truncate long category labels for axis (full name stays in tooltip). */
export function truncateAxisLabel(label, max = 14) {
  const s = String(label || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}
