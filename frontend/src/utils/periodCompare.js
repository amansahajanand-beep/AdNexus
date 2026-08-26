import { shiftYMD } from './datetime';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const COMPARE_MODES = [
  { id: 'prior', label: 'Prior period' },
  { id: 'lastWeek', label: 'Last week' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'custom', label: 'Custom range' },
];

function daysInclusive(startDate, endDate) {
  const a = Date.parse(`${startDate}T00:00:00Z`);
  const b = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

export function shiftYMDMonths(ymd, months) {
  const raw = String(ymd || '').trim();
  if (!YMD_RE.test(raw)) return raw;
  const [y, m, d] = raw.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Equal-length window immediately before `startDate`. */
export function previousPeriodRange(startDate, endDate) {
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  if (!YMD_RE.test(start) || !YMD_RE.test(end) || end < start) return null;
  const len = daysInclusive(start, end);
  if (len < 1) return null;
  const priorEnd = shiftYMD(start, -1);
  const priorStart = shiftYMD(priorEnd, -(len - 1));
  return { startDate: priorStart, endDate: priorEnd };
}

/** Resolve the compare window for a selected mode. */
export function resolveCompareRange(mode, startDate, endDate, custom = {}) {
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  if (!YMD_RE.test(start) || !YMD_RE.test(end) || end < start) return null;
  if (mode === 'lastWeek') {
    return { startDate: shiftYMD(start, -7), endDate: shiftYMD(end, -7) };
  }
  if (mode === 'lastMonth') {
    return { startDate: shiftYMDMonths(start, -1), endDate: shiftYMDMonths(end, -1) };
  }
  if (mode === 'custom') {
    const cs = String(custom.startDate || '').trim();
    const ce = String(custom.endDate || '').trim();
    if (!YMD_RE.test(cs) || !YMD_RE.test(ce) || ce < cs) return null;
    return { startDate: cs, endDate: ce };
  }
  return previousPeriodRange(start, end);
}

export function compareLabelFor(mode, range) {
  if (mode === 'lastWeek') return 'vs last week';
  if (mode === 'lastMonth') return 'vs last month';
  if (mode === 'custom' && range?.startDate && range?.endDate) {
    return range.startDate === range.endDate
      ? `vs ${range.startDate}`
      : `vs ${range.startDate} → ${range.endDate}`;
  }
  return 'vs prior period';
}

export function isPeriodAllowed(range, restriction) {
  if (!range?.startDate || !range?.endDate) return false;
  if (!restriction?.startDate) return true;
  return range.endDate >= restriction.startDate && range.startDate <= restriction.endDate;
}

export function pctChange(current, prior) {
  const c = Number(current) || 0;
  const p = Number(prior) || 0;
  if (p === 0) return c === 0 ? 0 : null;
  return +(((c - p) / Math.abs(p)) * 100).toFixed(1);
}

export function readSummaryTotals(summary = {}) {
  return {
    impressions: Number(summary.impressions) || 0,
    revenue: Number(summary.revenue ?? summary.selectRange) || 0,
    ecpm: Number(summary.ecpm) || 0,
    viewability: Number(summary.viewability) || 0,
  };
}

export function withPeriodDeltas(currentSummary = {}, priorSummary = null) {
  if (!priorSummary) {
    return {
      ...currentSummary,
      impressionsChange: null,
      revenueChange: null,
      selectRangeChange: null,
      ecpmChange: null,
      viewabilityChange: null,
    };
  }
  const cur = readSummaryTotals(currentSummary);
  const prev = readSummaryTotals(priorSummary);
  return {
    ...currentSummary,
    impressionsChange: pctChange(cur.impressions, prev.impressions),
    revenueChange: pctChange(cur.revenue, prev.revenue),
    selectRangeChange: pctChange(cur.revenue, prev.revenue),
    ecpmChange: pctChange(cur.ecpm, prev.ecpm),
    viewabilityChange: pctChange(cur.viewability, prev.viewability),
  };
}

/** Align prior daily revenue onto the current series by index (same-length windows). */
export function overlayPriorDaily(currentDaily = [], priorDaily = []) {
  const prior = Array.isArray(priorDaily) ? priorDaily : [];
  return (Array.isArray(currentDaily) ? currentDaily : []).map((d, i) => ({
    ...d,
    priorRevenue: prior[i] != null ? Number(prior[i].revenue ?? prior[i].earning) || 0 : null,
  }));
}

function shareValue(row) {
  return Number(row?.value ?? row?.revenue) || 0;
}

function shareName(row) {
  return String(row?.name || row?.label || '').trim();
}

/**
 * Ranked “what changed” vs prior period (sites / countries / KPIs).
 */
export function buildInsights({
  currentSummary,
  priorSummary,
  currentShare = [],
  priorShare = [],
  currentCountry = [],
  priorCountry = [],
  comparePhrase = 'vs prior period',
} = {}) {
  const items = [];
  const cur = readSummaryTotals(currentSummary || {});
  const prev = priorSummary ? readSummaryTotals(priorSummary) : null;

  if (prev) {
    const rev = pctChange(cur.revenue, prev.revenue);
    const ecpm = pctChange(cur.ecpm, prev.ecpm);
    if (rev != null && Math.abs(rev) >= 5) {
      items.push({
        id: 'kpi-revenue',
        text: `Revenue ${rev > 0 ? '+' : ''}${rev}% ${comparePhrase}`,
        tone: rev < 0 ? 'down' : 'up',
      });
    }
    if (ecpm != null && Math.abs(ecpm) >= 4) {
      items.push({
        id: 'kpi-ecpm',
        text: `eCPM ${ecpm > 0 ? '+' : ''}${ecpm}% ${comparePhrase}`,
        tone: ecpm < 0 ? 'down' : 'up',
      });
    }
  }

  const priorMap = Object.fromEntries(
    (priorShare || []).map((row) => [shareName(row), shareValue(row)]).filter(([n]) => n)
  );
  (currentShare || []).slice(0, 12).forEach((row) => {
    const name = shareName(row);
    const prevVal = priorMap[name];
    if (!name || !(prevVal > 0)) return;
    const pct = pctChange(shareValue(row), prevVal);
    if (pct == null || Math.abs(pct) < 8) return;
    items.push({
      id: `site-${name}`,
      text: `${name} revenue ${pct > 0 ? '+' : ''}${pct}%`,
      tone: pct < 0 ? 'down' : 'up',
    });
  });

  const priorC = Object.fromEntries(
    (priorCountry || []).map((row) => [shareName(row), shareValue(row)]).filter(([n]) => n)
  );
  (currentCountry || []).slice(0, 8).forEach((row) => {
    const name = shareName(row);
    const prevVal = priorC[name];
    if (!name || !(prevVal > 0)) return;
    const pct = pctChange(shareValue(row), prevVal);
    if (pct == null || Math.abs(pct) < 10) return;
    items.push({
      id: `cty-${name}`,
      text: `${name} ${pct > 0 ? '+' : ''}${pct}%`,
      tone: pct < 0 ? 'down' : 'up',
    });
  });

  return items
    .sort((a, b) => {
      const pa = Number(String(a.text).match(/-?\d+(\.\d+)?/)?.[0]) || 0;
      const pb = Number(String(b.text).match(/-?\d+(\.\d+)?/)?.[0]) || 0;
      return Math.abs(pb) - Math.abs(pa);
    })
    .slice(0, 3);
}
