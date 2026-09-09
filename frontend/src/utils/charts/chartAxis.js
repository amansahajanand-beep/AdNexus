/**
 * Shared chart axis helpers — keep full datasets; only thin visible ticks / compact labels.
 */

/** Compact axis tick for money (avoids $16,000.00 clipping). Tooltips can stay full. */
export function formatAxisMoney(value, currency = 'USD') {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const sym = currency === 'USD' || !currency ? '$' : '';
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(abs >= 10_000 ? 0 : 1)}K`;
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

/** Left YAxis width so compact ticks never clip (includes padding inside the axis band). */
export function yAxisWidthForValues(values = [], format = 'raw', { isNarrow = false } = {}) {
  const sample = (values.length ? values : [0])
    .map((v) => formatAxisMetric(v, format, 'USD'))
    .sort((a, b) => b.length - a.length)[0] || '$0';
  const approx = Math.ceil(sample.length * (isNarrow ? 8.5 : 9)) + 20;
  const min = isNarrow ? 52 : 60;
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
  if (pointCount > 90) return mon;
  if (pointCount > 31) return `${mon} ${p.d}`;
  return `${mon} ${p.d}`;
}

/**
 * Explicit tick list — more reliable than Recharts `interval` for long ranges.
 * Always includes first + last date.
 */
export function pickDateTicks(dates = [], { isNarrow = false } = {}) {
  const list = (dates || []).map((d) => (typeof d === 'object' ? (d.date || d.name) : d)).filter(Boolean);
  const n = list.length;
  if (n <= 1) return list;
  // Keep sparse enough that angled labels never collide on phone or desktop.
  const maxTicks = isNarrow
    ? (n > 45 ? 4 : n > 14 ? 5 : 6)
    : (n > 90 ? 5 : n > 45 ? 6 : n > 14 ? 7 : 8);
  if (n <= maxTicks) return list;
  const ticks = [];
  const lastIdx = n - 1;
  for (let i = 0; i < maxTicks; i += 1) {
    const idx = i === maxTicks - 1 ? lastIdx : Math.round((i * lastIdx) / (maxTicks - 1));
    const v = list[idx];
    if (ticks[ticks.length - 1] !== v) ticks.push(v);
  }
  return ticks;
}

/**
 * Chart margins — left/right must leave room OUTSIDE the plot for axis labels.
 * Bug fix: never cap left with Math.min(8/12) — that was clipping Y labels.
 */
export function chartMargins({
  isNarrow = false,
  hasAngledX = false,
  yWidth = 56,
  rightWidth = 0,
} = {}) {
  return {
    top: 12,
    // Extra pad outside the YAxis band so currency ticks never hug/clip the card edge.
    left: Math.max(isNarrow ? 8 : 12, Math.ceil((yWidth || 0) * 0.08)),
    right: Math.max(isNarrow ? 14 : 18, rightWidth ? Math.min(rightWidth, isNarrow ? 60 : 76) : 0),
    bottom: hasAngledX ? (isNarrow ? 52 : 42) : 14,
  };
}

/** Category (horizontal bar) Y-axis width + truncation that fits that width. */
export function categoryAxisWidth({ isNarrow = false } = {}) {
  return isNarrow ? 108 : 148;
}

export function truncateAxisLabel(label, max = 14) {
  const s = String(label || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Max chars that fit roughly in categoryAxisWidth. */
export function categoryLabelMaxChars({ isNarrow = false } = {}) {
  return isNarrow ? 13 : 20;
}

/**
 * Ideal inner width for a date series. Returns null when the chart should
 * simply fill the card (desktop, or a short phone series).
 * On phones, 7d / 30d / 90d expand past the viewport so the user can swipe.
 */
export function scrollableChartMinWidth(pointCount, { isNarrow = false } = {}) {
  const n = Math.max(0, Number(pointCount) || 0);
  if (!isNarrow) return null;
  if (n <= 6) return null;
  return Math.max(640, Math.round(n * 44));
}

/**
 * Recharts XAxis props for date series.
 * Prefer explicit `ticks` + short labels. When `scrollable`, allow denser ticks.
 */
export function dateAxisProps(pointCount, { isNarrow = false, dates = null, scrollable = false } = {}) {
  const n = Math.max(0, Number(pointCount) || (dates?.length || 0));
  const angled = n > 7;
  let ticks;
  if (Array.isArray(dates) && dates.length) {
    if (scrollable) {
      const every = n > 180 ? 14 : n > 90 ? 10 : 7;
      const list = dates.map((d) => (typeof d === 'object' ? (d.date || d.name) : d)).filter(Boolean);
      const picked = [];
      for (let i = 0; i < list.length; i += every) picked.push(list[i]);
      if (picked[picked.length - 1] !== list[list.length - 1]) picked.push(list[list.length - 1]);
      ticks = picked;
    } else {
      ticks = pickDateTicks(dates, { isNarrow });
    }
  }
  return {
    type: 'category',
    ...(ticks ? { ticks } : {
      interval: n <= 7 ? 0 : Math.max(0, Math.ceil(n / (isNarrow ? 4 : 7)) - 1),
    }),
    minTickGap: scrollable ? (isNarrow ? 22 : 18) : (isNarrow ? 36 : 28),
    angle: angled ? (isNarrow ? -45 : -35) : 0,
    textAnchor: angled ? 'end' : 'middle',
    height: angled ? (isNarrow ? 64 : 52) : 28,
    tickMargin: angled ? 10 : 6,
    tickFormatter: (v) => formatDateTick(v, n),
    tick: { fontSize: isNarrow ? 9 : 10, fill: '#5f6368' },
    tickLine: false,
    axisLine: false,
  };
}
