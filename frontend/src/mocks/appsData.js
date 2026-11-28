/**
 * Deterministic static mock data for the Apps module (local UI development only).
 * Every number derives from the app's id via a seeded PRNG, so values are stable across reloads and each
 * app always shows its own data. Nothing here touches the network.
 *
 * 361 days of daily history are generated per app (2025-12-01 → 2026-11-26). Every date range (Today … Lifetime)
 * is a window over that history, so the list, KPIs, charts and tables always agree with each other.
 */

export const USD_TO_INR = 83.5;

/** Fixed "today" so the data never shifts between sessions. */
const ANCHOR = new Date(Date.UTC(2026, 10, 26)); // 2026-11-26
const DAY = 86400000;
const HISTORY_START = new Date(Date.UTC(2025, 11, 1)); // 2025-12-01

const APP_SEEDS = [
  ['Puzzle Quest Saga', 'puzzlequestsaga', 'Game'],
  ['Block Blast Master', 'blockblastmaster', 'Game'],
  ['Word Connect Pro', 'wordconnectpro', 'Game'],
  ['Idle Tycoon City', 'idletycooncity', 'Game'],
  ['Solitaire Classic', 'solitaireclassic', 'Game'],
  ['Bubble Shooter Pop', 'bubbleshooterpop', 'Game'],
  ['Racing Rivals 3D', 'racingrivals3d', 'Game'],
  ['Fruit Merge Mania', 'fruitmergemania', 'Game'],
  ['Photo Editor Plus', 'photoeditorplus', 'Tools'],
  ['QR Scanner Fast', 'qrscannerfast', 'Tools'],
  ['PDF Reader Lite', 'pdfreaderlite', 'Tools'],
  ['Phone Cleaner Boost', 'phonecleanerboost', 'Tools'],
  ['Battery Saver Pro', 'batterysaverpro', 'Tools'],
  ['Flashlight Bright', 'flashlightbright', 'Tools'],
  ['Compass & Maps', 'compassmaps', 'Tools'],
  ['Weather Live Radar', 'weatherliveradar', 'Utility'],
  ['Daily Horoscope', 'dailyhoroscope', 'Lifestyle'],
  ['Fitness Steps Tracker', 'fitnessstepstracker', 'Health'],
  ['Meditation Calm', 'meditationcalm', 'Health'],
  ['Recipe Book India', 'recipebookindia', 'Lifestyle'],
  ['Cricket Live Score', 'cricketlivescore', 'Sports'],
  ['Football Fan Zone', 'footballfanzone', 'Sports'],
  ['News Today Digest', 'newstodaydigest', 'News'],
  ['Video Status Maker', 'videostatusmaker', 'Social'],
  ['Wallpaper HD 4K', 'wallpaperhd4k', 'Personalization'],
  ['Ringtone Studio', 'ringtonestudio', 'Personalization'],
  ['Keyboard Emoji Pro', 'keyboardemojipro', 'Personalization'],
  ['Language Translator', 'languagetranslator', 'Education'],
  ['Math Genius Kids', 'mathgeniuskids', 'Education'],
  ['Expense Manager', 'expensemanager', 'Finance'],
  ['Kids Coloring Fun', 'kidscoloringfun', 'Education'],
];

const COUNTRIES = [
  ['United States', 'US', 1.0, 1.0],
  ['India', 'IN', 0.35, 0.8],
  ['United Kingdom', 'GB', 0.62, 1.0],
  ['Germany', 'DE', 0.55, 1.0],
  ['Brazil', 'BR', 0.3, 0.7],
  ['Indonesia', 'ID', 0.22, 0.6],
  ['Canada', 'CA', 0.58, 1.0],
  ['Australia', 'AU', 0.5, 0.9],
  ['France', 'FR', 0.46, 0.9],
  ['Philippines', 'PH', 0.2, 0.5],
];

const NETWORKS = [
  'Google AdMob',
  'Meta Audience Network',
  'AppLovin MAX',
  'Unity Ads',
  'ironSource',
  'Mintegral',
];

// ─── date ranges ────────────────────────────────────────────────────────────

export const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'thisYear', label: 'This year' },
  { id: 'lifetime', label: 'Lifetime' },
];
export const DEFAULT_RANGE = '30d';
export const normalizeRange = (id) => (RANGES.some((r) => r.id === id) ? id : DEFAULT_RANGE);

// ─── deterministic helpers ──────────────────────────────────────────────────

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n, d = 2) => {
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
};
const ymd = (d) => d.toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pctChange(cur, prev) {
  if (!prev) return cur ? 100 : 0;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

export function signalFor({ status, roas, profit }) {
  if (status === 'Inactive') return 'Pause';
  if (profit < 0) return roas < 0.8 ? 'Pause' : 'Watch';
  if (roas >= 2) return 'Scale';
  if (roas >= 1.3) return 'Optimize';
  return 'Watch';
}

// ─── shared calendar ────────────────────────────────────────────────────────

export const DATES = [];
for (let t = HISTORY_START.getTime(); t <= ANCHOR.getTime(); t += DAY) DATES.push(ymd(new Date(t)));
const LAST = DATES.length - 1;
const idxOf = (date) => DATES.indexOf(date);

const fmtDay = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const fmtDayShort = (date) => {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
const spanLabel = (a, b) => {
  if (a === b) return fmtDay(DATES[a]);
  const sameYear = DATES[a].slice(0, 4) === DATES[b].slice(0, 4);
  return `${sameYear ? fmtDayShort(DATES[a]) : fmtDay(DATES[a])} – ${fmtDay(DATES[b])}`;
};

/** Resolve a range id → inclusive index windows over DATES (prev is null when history is too short / not applicable). */
const RANGE_CACHE = new Map();
export function getRangeInfo(rangeIdIn) {
  const id = normalizeRange(rangeIdIn);
  if (RANGE_CACHE.has(id)) return RANGE_CACHE.get(id);

  const monthKey = DATES[LAST].slice(0, 7); // 2026-11
  const thisMonthStart = idxOf(`${monthKey}-01`);
  const lastMonthStart = idxOf('2026-10-01');
  const prevMonthStart = idxOf('2026-09-01');
  const yearStart = idxOf('2026-01-01');

  let cur;
  let prev = null;
  const trailing = (n) => {
    cur = [LAST - n + 1, LAST];
    prev = [LAST - 2 * n + 1, LAST - n];
  };
  switch (id) {
    case 'today': trailing(1); break;
    case 'yesterday': cur = [LAST - 1, LAST - 1]; prev = [LAST - 2, LAST - 2]; break;
    case '7d': trailing(7); break;
    case '30d': trailing(30); break;
    case 'thisMonth': {
      const len = LAST - thisMonthStart + 1;
      cur = [thisMonthStart, LAST];
      prev = [thisMonthStart - len, thisMonthStart - 1];
      break;
    }
    case 'lastMonth':
      cur = [lastMonthStart, thisMonthStart - 1];
      prev = [prevMonthStart, lastMonthStart - 1];
      break;
    case 'thisYear': cur = [yearStart, LAST]; break; // not enough history before 1 Jan for an equal-length prior period
    default: cur = [0, LAST]; // lifetime
  }
  if (prev && prev[0] < 0) prev = null;

  const info = {
    id,
    label: RANGES.find((r) => r.id === id).label,
    cur,
    prev,
    days: cur[1] - cur[0] + 1,
    spanLabel: spanLabel(cur[0], cur[1]),
    prevSpanLabel: prev ? spanLabel(prev[0], prev[1]) : null,
    compareLabel: prev ? 'vs previous period' : 'no prior period',
  };
  RANGE_CACHE.set(id, info);
  return info;
}

// ─── per-app base (daily history) ───────────────────────────────────────────

function buildBase(index) {
  const [name, pkgSlug, category] = APP_SEEDS[index];
  const id = `APP-${1001 + index}`;
  const rand = mulberry32(hashString(id));

  const statusRoll = rand();
  const status = statusRoll < 0.68 ? 'Active' : statusRoll < 0.88 ? 'Paused' : 'Inactive';
  const baseRevUsd = (status === 'Inactive' ? 30 : 160) + rand() * (status === 'Inactive' ? 120 : 3400);
  const targetRoas = 0.55 + rand() * 2.9;
  const growth = (rand() - 0.42) * 0.0016; // drift per day
  const weeklyAmp = 0.06 + rand() * 0.14;
  const eventDay = Math.floor(rand() * 300);

  const daily = DATES.map((date, i) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 1 + weeklyAmp : 1 - weeklyAmp / 2;
    const noise = 0.88 + rand() * 0.24;
    const spike = Math.abs(i - eventDay) < 3 ? 1.35 : 1;
    const trend = 1 + growth * i;
    const revenueUsd = Math.max(5, baseRevUsd * weekend * noise * spike * trend);
    const roasDay = Math.max(0.3, targetRoas * (0.82 + rand() * 0.36));
    const revenueInr = revenueUsd * USD_TO_INR;
    const expense = revenueInr / roasDay;
    const ecpm = 0.8 + rand() * 4.2;
    return {
      date,
      revenueUsd: round(revenueUsd),
      revenueInr: round(revenueInr),
      expense: round(expense),
      impressions: Math.round((revenueUsd / ecpm) * 1000),
    };
  });

  // static shares (per app) reused for every window
  const cRand = mulberry32(hashString(`${id}:country`));
  const cWeights = COUNTRIES.map(() => 0.4 + cRand() * 1.6)
    .map((w, k) => w * (COUNTRIES[k][2] + 0.4) ** 1.4 * (k === 0 ? 2.2 : 1));
  const cTotal = cWeights.reduce((s, w) => s + w, 0);
  const cCost = COUNTRIES.map((c, k) => (cWeights[k] / cTotal) * (0.75 + cRand() * 0.5) * (1.1 - c[3] * 0.15));
  const cCostTotal = cCost.reduce((s, w) => s + w, 0);
  const countryShares = COUNTRIES.map(([cName, code], k) => ({
    name: cName, code, share: cWeights[k] / cTotal, costShare: cCost[k] / cCostTotal,
  }));

  const nRand = mulberry32(hashString(`${id}:network`));
  const nCount = 4 + Math.floor(nRand() * 3); // 4–6 networks
  const nWeights = NETWORKS.slice(0, nCount).map((_, k) => (0.5 + nRand()) * (k === 0 ? 2 : 1));
  const nTotal = nWeights.reduce((s, w) => s + w, 0);
  const networkShares = NETWORKS.slice(0, nCount).map((n, k) => ({
    network: n,
    share: nWeights[k] / nTotal,
    imprFactor: 0.85 + nRand() * 0.3,
    fillBase: 0.55 + nRand() * 0.4,
  }));

  const ctr = 0.008 + mulberry32(hashString(`${id}:ctr`))() * 0.02;
  const peakHour = 9 + Math.floor(mulberry32(hashString(`${id}:peak`))() * 12); // 9–20

  return {
    id, name, pkgSlug, category, status, daily, countryShares, networkShares, ctr, peakHour,
  };
}

// ─── window aggregation ─────────────────────────────────────────────────────

const ZERO = {
  revenueUsd: 0, revenueInr: 0, expense: 0, impressions: 0,
};

function sumRows(rows) {
  return rows.reduce((s, r) => ({
    revenueUsd: s.revenueUsd + r.revenueUsd,
    revenueInr: s.revenueInr + r.revenueInr,
    expense: s.expense + r.expense,
    impressions: s.impressions + r.impressions,
  }), { ...ZERO });
}

function derive(label, s, extra = {}) {
  const profit = s.revenueInr - s.expense;
  return {
    label,
    ...extra,
    revenueUsd: round(s.revenueUsd),
    revenueInr: round(s.revenueInr),
    expense: round(s.expense),
    profit: round(profit),
    roas: round(s.expense ? s.revenueInr / s.expense : 0, 2),
    margin: round(s.revenueInr ? (profit / s.revenueInr) * 100 : 0, 1),
    impressions: Math.round(s.impressions),
  };
}

/** 24 hourly rows for one day; hours sum exactly to the day's totals. */
function hourlyRows(base, dayRow) {
  const rand = mulberry32(hashString(`${base.id}:${dayRow.date}:hourly`));
  const rev = [];
  const exp = [];
  for (let h = 0; h < 24; h += 1) {
    const diurnal = 0.5 + 0.5 * Math.cos((2 * Math.PI * (h - base.peakHour)) / 24);
    rev.push((0.25 + diurnal) * (0.85 + rand() * 0.3));
    exp.push((0.7 + 0.3 * diurnal) * (0.9 + rand() * 0.2));
  }
  const revSum = rev.reduce((s, w) => s + w, 0);
  const expSum = exp.reduce((s, w) => s + w, 0);
  let usdLeft = dayRow.revenueUsd;
  let inrLeft = dayRow.revenueInr;
  let expLeft = dayRow.expense;
  let imprLeft = dayRow.impressions;
  return rev.map((w, h) => {
    const last = h === 23;
    const usd = last ? usdLeft : round(dayRow.revenueUsd * (w / revSum));
    const inr = last ? inrLeft : round(dayRow.revenueInr * (w / revSum));
    const ex = last ? expLeft : round(dayRow.expense * (exp[h] / expSum));
    const im = last ? imprLeft : Math.round(dayRow.impressions * (w / revSum));
    usdLeft -= usd; inrLeft -= inr; expLeft -= ex; imprLeft -= im;
    return derive(`${String(h).padStart(2, '0')}:00`, {
      revenueUsd: usd, revenueInr: inr, expense: ex, impressions: im,
    });
  });
}

function monthlyRows(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const key = r.date.slice(0, 7);
    map.set(key, [...(map.get(key) || []), r]);
  });
  return [...map.entries()].map(([key, list]) => {
    const [y, m] = key.split('-').map(Number);
    return derive(`${MONTHS[m - 1]} ${y}`, sumRows(list));
  });
}

function sample(rows, key, max = 12) {
  const pick = rows.length <= max
    ? rows
    : Array.from({ length: max }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
  return pick.map((r) => ({ v: r[key] }));
}

function summarize(base, info) {
  const curRows = base.daily.slice(info.cur[0], info.cur[1] + 1);
  const cur = sumRows(curRows);
  const prev = info.prev ? sumRows(base.daily.slice(info.prev[0], info.prev[1] + 1)) : null;
  const profit = cur.revenueInr - cur.expense;
  const prevProfit = prev ? prev.revenueInr - prev.expense : null;
  const roas = cur.expense ? cur.revenueInr / cur.expense : 0;
  const margin = cur.revenueInr ? (profit / cur.revenueInr) * 100 : 0;
  const summary = {
    id: base.id,
    slug: base.id.toLowerCase(),
    name: base.name,
    packageName: `com.adnexus.${base.pkgSlug}`,
    category: base.category,
    status: base.status,
    expense: round(cur.expense),
    revenueInr: round(cur.revenueInr),
    revenueUsd: round(cur.revenueUsd),
    profit: round(profit),
    margin: round(margin, 1),
    roas: round(roas, 2),
    profitVsPrev: prev ? round(pctChange(profit, prevProfit), 1) : null,
    signal: signalFor({ status: base.status, roas, profit }),
    prev: prev ? {
      expense: prev.expense, revenueInr: prev.revenueInr, revenueUsd: prev.revenueUsd, profit: prevProfit,
    } : null,
  };
  return { summary, curRows, cur, prev, profit, prevProfit, roas, margin };
}

function buildDetail(base, info) {
  const {
    summary, curRows, cur, prev, roas, margin, prevProfit, profit,
  } = summarize(base, info);

  // series per granularity
  const series = {};
  let granOptions;
  let defaultGran;
  let sparkRows;
  if (info.days === 1) {
    series.hourly = hourlyRows(base, curRows[0]);
    granOptions = ['hourly'];
    defaultGran = 'hourly';
    sparkRows = series.hourly;
  } else {
    series.daily = curRows.map((r) => derive(fmtDayShort(r.date), r, { date: r.date }));
    granOptions = ['daily'];
    if (info.days >= 28) {
      series.monthly = monthlyRows(curRows);
      granOptions.push('monthly');
    }
    defaultGran = info.days > 62 ? 'monthly' : 'daily';
    sparkRows = series.daily;
  }

  const cmp = (curV, prevV) => (prev ? round(pctChange(curV, prevV), 1) : null);
  const prevRoas = prev && prev.expense ? prev.revenueInr / prev.expense : 0;
  const prevMargin = prev && prev.revenueInr ? (prevProfit / prev.revenueInr) * 100 : 0;
  const clicks = Math.round(cur.impressions * base.ctr);
  const prevClicks = prev ? Math.round(prev.impressions * base.ctr) : 0;

  const kpis = [
    { key: 'revenueInr', label: 'Revenue (INR)', value: summary.revenueInr, format: 'money', currency: 'INR', change: cmp(cur.revenueInr, prev?.revenueInr), spark: sample(sparkRows, 'revenueInr') },
    { key: 'revenueUsd', label: 'Revenue (USD)', value: summary.revenueUsd, format: 'money', currency: 'USD', change: cmp(cur.revenueUsd, prev?.revenueUsd), spark: sample(sparkRows, 'revenueUsd') },
    { key: 'expense', label: 'Expense (INR)', value: summary.expense, format: 'money', currency: 'INR', change: cmp(cur.expense, prev?.expense), spark: sample(sparkRows, 'expense') },
    { key: 'profit', label: 'Net profit (INR)', value: summary.profit, format: 'money', currency: 'INR', change: summary.profitVsPrev, spark: sample(sparkRows, 'profit') },
    { key: 'roas', label: 'ROAS', value: summary.roas, format: 'ratio', change: cmp(roas, prevRoas), spark: sample(sparkRows, 'roas') },
    { key: 'margin', label: 'Margin', value: summary.margin, format: 'percent', change: prev ? round(margin - prevMargin, 1) : null, spark: sample(sparkRows, 'margin') },
    { key: 'impressions', label: 'Impressions', value: cur.impressions, format: 'number', change: cmp(cur.impressions, prev?.impressions), spark: sample(sparkRows, 'impressions') },
    { key: 'clicks', label: 'Clicks', value: clicks, format: 'number', change: cmp(clicks, prevClicks), spark: sample(sparkRows, 'impressions') },
  ];

  const countries = base.countryShares.map((c) => {
    const rev = cur.revenueInr * c.share;
    const exp = cur.expense * c.costShare;
    const impr = Math.round(cur.impressions * c.share);
    return {
      country: c.name,
      code: c.code,
      revenueInr: round(rev),
      revenueUsd: round(rev / USD_TO_INR),
      expense: round(exp),
      profit: round(rev - exp),
      roas: round(exp ? rev / exp : 0, 2),
      impressions: impr,
      ecpm: round(impr ? (rev / USD_TO_INR / impr) * 1000 : 0, 2),
      share: round(c.share * 100, 1),
    };
  }).sort((a, b) => b.revenueInr - a.revenueInr);

  const networks = base.networkShares.map((n) => {
    const rev = cur.revenueUsd * n.share;
    const impr = Math.round(cur.impressions * n.share * n.imprFactor);
    const requests = Math.round(impr / n.fillBase);
    return {
      network: n.network,
      revenueUsd: round(rev),
      revenueInr: round(rev * USD_TO_INR),
      impressions: impr,
      requests,
      fillRate: round(requests ? (impr / requests) * 100 : 0, 1),
      ecpm: round(impr ? (rev / impr) * 1000 : 0, 2),
      share: round(n.share * 100, 1),
    };
  }).sort((a, b) => b.revenueUsd - a.revenueUsd);

  return {
    ...summary,
    profit: round(profit),
    rangeId: info.id,
    rangeLabel: info.label,
    spanLabel: info.spanLabel,
    compareLabel: info.compareLabel,
    kpis,
    series,
    granOptions,
    defaultGran,
    countries,
    networks,
  };
}

// ─── caches / public API ────────────────────────────────────────────────────

let BASES = null;
const bases = () => {
  if (!BASES) BASES = APP_SEEDS.map((_, i) => buildBase(i));
  return BASES;
};
const LIST_CACHE = new Map();
const DETAIL_CACHE = new Map();

/** All apps (summary rows for the All Apps table) for a date range. */
export function getAllApps(rangeId = DEFAULT_RANGE) {
  const info = getRangeInfo(rangeId);
  if (!LIST_CACHE.has(info.id)) {
    LIST_CACHE.set(info.id, bases().map((b) => summarize(b, info).summary));
  }
  return LIST_CACHE.get(info.id);
}

/** Full per-app detail for a date range. Case-insensitive id; null for an unknown id. */
export function getAppDetail(appId, rangeId = DEFAULT_RANGE) {
  const info = getRangeInfo(rangeId);
  const base = bases().find((b) => b.id.toLowerCase() === String(appId || '').toLowerCase());
  if (!base) return null;
  const key = `${base.id}|${info.id}`;
  if (!DETAIL_CACHE.has(key)) DETAIL_CACHE.set(key, buildDetail(base, info));
  return DETAIL_CACHE.get(key);
}

/** Raw per-app base (daily history + seeded fields) for the app report layer. Null for an unknown id. */
export function getAppRaw(appId) {
  return bases().find((b) => b.id.toLowerCase() === String(appId || '').toLowerCase()) || null;
}

export const APP_STATUSES = ['Active', 'Paused', 'Inactive'];
export const APP_SIGNALS = ['Scale', 'Optimize', 'Watch', 'Pause'];
