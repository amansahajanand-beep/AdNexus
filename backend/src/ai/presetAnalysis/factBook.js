/**
 * Fact book: every number the analysis may mention gets an id (F1, F2, ...) with a display string.
 * The model cites ids; the screen renders the display strings, so a figure shown to the user always
 * comes from the data and never from the model's own arithmetic.
 */

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function pctChange(curr, prev) {
  const c = num(curr);
  const p = num(prev);
  if (c == null || p == null || Math.abs(p) < 1e-9) return null;
  return ((c - p) / Math.abs(p)) * 100;
}

function formatMoney(value, currency = 'USD') {
  const v = num(value);
  if (v == null) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 10000 ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(digits)}`;
  }
}

function formatCount(value) {
  const v = num(value);
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString('en-US');
}

function formatPercent(value, digits = 1) {
  const v = num(value);
  return v == null ? '—' : `${v.toFixed(digits)}%`;
}

function formatChange(change) {
  if (change == null) return '';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  return `${sign}${Math.abs(change).toFixed(1)}%`;
}

function formatByUnit(value, unit, currency) {
  if (unit === 'money') return formatMoney(value, currency);
  if (unit === 'percent') return formatPercent(value);
  return formatCount(value);
}

class FactBook {
  constructor(currency = 'USD') {
    this.currency = currency;
    this.facts = {};
    this.count = 0;
  }

  /**
   * Register a fact and return its id.
   * @param {string} label   e.g. "Estimated earnings" or "Site quiz2.example.com earnings"
   * @param {number} value
   * @param {'money'|'count'|'percent'} unit
   * @param {{prev?: number, change?: number|null, share?: number, detail?: string, currency?: string}} [extra]
   */
  add(label, value, unit, extra = {}) {
    this.count += 1;
    const id = `F${this.count}`;
    const cur = extra.currency || this.currency;
    const change = extra.change !== undefined
      ? extra.change
      : (extra.prev !== undefined ? pctChange(value, extra.prev) : null);
    let display = `${label} ${formatByUnit(value, unit, cur)}`;
    if (extra.share != null) display += ` (${formatPercent(extra.share)} of total)`;
    if (change != null) display += ` (${formatChange(change)} vs prior)`;
    if (extra.detail) display += ` — ${extra.detail}`;
    this.facts[id] = {
      label, value: num(value), unit, display, valueText: formatByUnit(value, unit, cur), change,
    };
    return id;
  }

  /** Facts the screen needs; the structured fields let it draw figure tiles without parsing text. */
  pick(ids) {
    const out = {};
    for (const id of ids) {
      const f = this.facts[id];
      if (f) out[id] = { display: f.display, label: f.label, valueText: f.valueText, unit: f.unit, change: f.change == null ? null : Number(f.change.toFixed(1)) };
    }
    return out;
  }

  /** Display strings for every fact (small enough to send in full). */
  displays() {
    const out = {};
    for (const [id, f] of Object.entries(this.facts)) out[id] = { display: f.display };
    return out;
  }
}

/** Population mean and standard deviation. */
function meanStd(values) {
  if (!values.length) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Days that sit far outside the rest of the period. Needs at least 5 days; each day is compared
 * with the other days so one extreme day cannot hide itself by inflating the spread.
 */
function findAnomalies(points, { zThreshold = 2.2, minRelative = 0.25 } = {}) {
  const series = points.map((p) => ({ date: p.date, v: num(p.v) })).filter((p) => p.v != null);
  if (series.length < 5) return [];
  const out = [];
  for (let i = 0; i < series.length; i += 1) {
    const others = series.filter((_, j) => j !== i).map((p) => p.v);
    const { mean, std } = meanStd(others);
    if (mean <= 0) continue;
    const rel = (series[i].v - mean) / mean;
    const z = std > 0 ? (series[i].v - mean) / std : 0;
    if (Math.abs(z) >= zThreshold && Math.abs(rel) >= minRelative) {
      out.push({ date: series[i].date, value: series[i].v, expected: mean, deviationPct: rel * 100 });
    }
  }
  return out.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct)).slice(0, 3);
}

/** Share of the total taken by the top n rows. */
function topShare(rows, key, n) {
  const values = rows.map((r) => num(r[key]) || 0);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return (values.slice().sort((a, b) => b - a).slice(0, n).reduce((a, b) => a + b, 0) / total) * 100;
}

/**
 * Join current and prior-period rows by name and rank by absolute change.
 * Rows that exist only in one period count as full gains or losses.
 */
function computeMovers(currRows, prevRows, key = 'earnings') {
  const prev = new Map((prevRows || []).map((r) => [r.name, num(r[key]) || 0]));
  const seen = new Set();
  const movers = [];
  for (const r of currRows || []) {
    const c = num(r[key]) || 0;
    const p = prev.get(r.name) || 0;
    seen.add(r.name);
    movers.push({ name: r.name, curr: c, prev: p, delta: c - p, pct: pctChange(c, p) });
  }
  for (const [name, p] of prev) {
    if (!seen.has(name)) movers.push({ name, curr: 0, prev: p, delta: -p, pct: -100 });
  }
  return movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

module.exports = {
  FactBook,
  num,
  pctChange,
  formatMoney,
  formatCount,
  formatPercent,
  formatChange,
  findAnomalies,
  topShare,
  computeMovers,
  meanStd,
};
