/** Shared pieces for the fact-sheet builders. */
const crypto = require('crypto');
const { FactBook, num, formatMoney } = require('./factBook');
const { Signals } = require('./signals');
const { todayInTZ } = require('../../utils/datetime');

const STALE_HOURS = 36;
const MAX_TREND_POINTS = 31;
/** Below this many currency units, percentage swings are noise rather than findings. */
const MATERIAL_AMOUNT = 5;

const FILTER_DIM = {
  apps: 'app', sites: 'site', countries: 'country', formats: 'format', platforms: 'platform', adUnits: 'ad_unit',
};

/**
 * Which splits ("by country", "by site", ...) can be trusted when inventory filters are applied.
 * The stored facts are one-dimensional, so a filter on one kind of inventory cannot narrow a split by another:
 * the split would silently show the whole account. With one kind of filter only that same split is exact; with
 * several kinds none is, and the totals are approximate. Without filters every split is fine.
 */
function reliableDims(filters, dims) {
  const kinds = [...new Set(Object.entries(filters || {})
    .filter(([key, list]) => FILTER_DIM[key] && Array.isArray(list) && list.length)
    .map(([key]) => FILTER_DIM[key]))];
  if (!kinds.length) return { dims, note: null };
  const allowed = kinds.length === 1 ? dims.filter((d) => d === kinds[0]) : [];
  let note = null;
  if (kinds.length > 1) {
    note = 'Filters on several kinds of inventory are combined approximately, so no split by item is shown.';
  } else if (allowed.length < dims.length) {
    note = 'Splits by other kinds of inventory are not shown while a filter is applied, because that data cannot be narrowed by the filter.';
  }
  return { dims: allowed, note };
}

function newSheet(request, page, currency = 'USD') {
  return {
    request,
    page,
    currency,
    book: new FactBook(currency),
    signals: new Signals(),
    notes: [],
    metricIds: [],
    trend: null,
    breakdowns: [],
    // What the screen draws; never sent to the model.
    charts: { trend: null, breakdowns: [], compare: [] },
    syncedAt: null,
    syncError: null,
    noData: false,
    small: false,
  };
}

/** Group a long daily series into at most MAX_TREND_POINTS buckets so the prompt stays small. */
function downsample(points) {
  if (points.length <= MAX_TREND_POINTS) return points;
  const size = Math.ceil(points.length / MAX_TREND_POINTS);
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size);
    out.push({
      date: `${chunk[0].date}..${chunk[chunk.length - 1].date.slice(5)}`,
      v: chunk.reduce((a, p) => a + (num(p.v) || 0), 0),
    });
  }
  return out;
}

function round(v, digits = 2) {
  const n = num(v);
  return n == null ? null : Number(n.toFixed(digits));
}

/** Add sync-age and sync-error findings from the newest sync time across accounts. */
function applyFreshness(sheet, accounts = []) {
  const times = accounts.map((a) => Date.parse(a.lastSyncAt)).filter(Number.isFinite);
  if (times.length) sheet.syncedAt = new Date(Math.max(...times)).toISOString();
  const failing = accounts.find((a) => a.lastSyncError);
  if (failing) sheet.syncError = String(failing.lastSyncError).slice(0, 160);

  if (sheet.syncError) {
    sheet.signals.add(
      'critical', 'sync_error', 'Data sync is failing',
      `The latest sync reported an error (${sheet.syncError}). Figures below may be incomplete.`,
      [],
      { priority: 5, action: { title: 'Fix the data connection', detail: 'Reconnect the account in Admin, then run a sync.' } }
    );
  } else if (sheet.syncedAt) {
    const hours = (Date.now() - Date.parse(sheet.syncedAt)) / 3600000;
    if (hours > STALE_HOURS) {
      sheet.signals.add(
        'warning', 'stale_data', 'Data is out of date',
        `The last successful sync was ${Math.round(hours)} hours ago, so recent days may be missing.`,
        [],
        { priority: 4, action: { title: 'Run a sync', detail: 'Start a sync from Admin and check again in a few minutes.' } }
      );
    }
  }
}

/** True when both periods are too small for percentage changes to mean anything. */
function isSmall(currValue, prevValue) {
  return Math.abs(num(currValue) || 0) < MATERIAL_AMOUNT && Math.abs(num(prevValue) || 0) < MATERIAL_AMOUNT;
}

/**
 * Turn a finished sheet into what the model sees, what the screen shows, and a stable hash.
 * The hash covers only data content, so identical numbers reuse a stored analysis.
 */
function finalizeSheet(sheet) {
  const { request } = sheet;
  const signals = sheet.signals.top();
  const facts = {};
  for (const [id, f] of Object.entries(sheet.book.facts)) facts[id] = f.display;

  const prompt = {
    page: sheet.page,
    period: { start: request.start, end: request.end, days: request.days },
    compared_with: { start: request.compare.start, end: request.compare.end },
    currency: sheet.currency,
    filters: request.filterText,
    // No "hours ago" here: it changes every minute and would defeat result caching.
    data_freshness: sheet.syncedAt ? `last synced ${sheet.syncedAt}` : 'unknown',
    notes: sheet.notes,
    metrics: sheet.metricIds,
    daily_trend: sheet.trend
      ? {
        metric: sheet.trend.label,
        points: sheet.trend.points.map((p) => [p.date, round(p.v)]),
        unusual_days: sheet.trend.anomalies,
      }
      : null,
    breakdowns: sheet.breakdowns,
    detected_signals: signals.map((s) => ({
      id: s.id, severity: s.severity, title: s.title, text: s.text, facts: s.factIds,
    })),
    facts,
  };

  // Finished days do not change when a sync runs, so their key ignores the sync time. Only a range
  // that includes today needs it, because new data can still arrive for it.
  const includesToday = request.end >= todayInTZ(request.dayTz);
  const hashed = includesToday ? prompt : { ...prompt, data_freshness: undefined };
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ prompt: hashed, depth: request.depth }))
    .digest('hex')
    .slice(0, 32);

  return {
    prompt,
    hash,
    signals,
    book: sheet.book,
    facts: sheet.book.displays(),
    syncedAt: sheet.syncedAt,
    noData: sheet.noData,
    charts: sheet.charts,
    currency: sheet.currency,
  };
}

/** Daily series for the chart. `kind` is the unit of the values: money | count | percent. */
function setTrendChart(sheet, label, kind, points, anomalyDays = []) {
  if (!points.length) return;
  sheet.charts.trend = {
    label, kind, points: points.map((p) => ({ date: p.date, v: round(p.v) })), anomalies: anomalyDays,
  };
}

/** This period against the prior one for a headline figure. */
function addCompare(sheet, label, kind, now, prev) {
  const n = num(now);
  const p = num(prev);
  if (n == null || p == null) return;
  sheet.charts.compare.push({ label, kind, now: round(n), prev: round(p) });
}

/** One ranked list for the chart. Items: { name, value, share?, change?, extra? }. */
function addBarChart(sheet, by, kind, items, extra = {}) {
  const list = items.filter((i) => i.name != null && Number.isFinite(i.value));
  if (list.length) sheet.charts.breakdowns.push({ by, kind, ...extra, items: list });
}

module.exports = {
  reliableDims,
  setTrendChart, addBarChart, addCompare, newSheet, downsample, round, applyFreshness, isSmall, finalizeSheet, MATERIAL_AMOUNT, formatMoney,
};
