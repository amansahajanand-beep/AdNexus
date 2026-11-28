/**
 * App-wise report data (local UI development only) — account/deduction/GST ledgers, insights, projection and
 * campaigns for one app. Everything derives from the same daily history as mocks/appsData.js, so the Apps list,
 * the detail KPIs and these tables always agree:
 *
 *   gross USD (sum of accounts) − deduction USD = net USD,   Total income ₹ = the app's revenue INR,
 *   Total expense ₹ = Ad expense + GST (18%),                Profit ₹ = Total income − Total expense.
 */
import {
  getAppRaw, getRangeInfo, DATES, USD_TO_INR, hashString, mulberry32, signalFor,
} from './appsData';

const GST_RATE = 0.18;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LAST = DATES.length - 1;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const idxOf = (date) => DATES.indexOf(date);
const ddmmyyyy = (date) => `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
const mmyyyy = (key) => `${key.slice(5, 7)}-${key.slice(0, 4)}`;

const PARTNERS = ['Hp Kp', 'Rohan Studio', 'Nexa Labs', 'Blue Orbit', 'Kiran Media', 'Zed Partners'];
const DEVELOPERS = ['Paragbhai', 'Ankit Soft', 'Mehul Apps', 'Orbit Devs', 'Pixel Forge', 'Dev Team A'];
const DESIGNERS = ['Paragbhai', 'Riya Designs', 'Studio Nine', 'Kavya Art', 'Mono Labs'];
const ADX_ACCOUNTS = [
  ['Appsaga Technologies LLC', 'info@appsagatechnologiesllc.com'],
  ['Nova Mobile Pvt Ltd', 'accounts@novamobile.in'],
  ['Pixel Harbor LLC', 'finance@pixelharbor.io'],
  ['Zenith Apps Inc', 'billing@zenithapps.co'],
];
const WEB_WORDS = ['finance', 'quiz', 'news', 'games', 'health', 'tools', 'recipes', 'sports', 'horoscope', 'learn'];
const WEB_BRANDS = ['financespher', 'quizverse', 'dailynestly', 'playcrate', 'gadgetnest', 'mediahubpro'];
const CAMPAIGN_COUNTRIES = ['United States', 'India', 'United Kingdom', 'Germany', 'Brazil', 'Indonesia', 'Canada', 'Australia'];
const OBJECTIVES = ['Installs', 'Retention', 'Reach', 'Re-engagement'];

// ─── per-app ledger (range independent) ─────────────────────────────────────

const LEDGER_CACHE = new Map();

function buildProfile(raw) {
  const pr = mulberry32(hashString(`${raw.id}:profile`));
  const pick = (a) => a[Math.floor(pr() * a.length)];
  const dedPct = 0.06 + pr() * 0.1;
  const profile = {
    platform: pr() < 0.8 ? 'Android' : 'iOS',
    organic: pr() < 0.7,
    partner: pick(PARTNERS),
    developer: pick(DEVELOPERS),
    designer: pick(DESIGNERS),
    dedPct,
    dedFeePct: dedPct * (0.55 + pr() * 0.3),
  };

  const nAdx = pr() < 0.35 ? 2 : 1;
  const start = Math.floor(pr() * ADX_ACCOUNTS.length);
  const accounts = Array.from({ length: nAdx }, (_, k) => {
    const [name, email] = ADX_ACCOUNTS[(start + k) % ADX_ACCOUNTS.length];
    return { id: `adx${k}`, kind: 'ADX · APP', name, sub: email, weight: 1.5 + pr() * 2 };
  });
  const nLinks = 1 + Math.floor(pr() * 3);
  const seen = new Set();
  for (let k = 0; k < nLinks; k += 1) {
    let domain;
    let guard = 0;
    do {
      domain = `${WEB_WORDS[Math.floor(pr() * WEB_WORDS.length)]}${10 + Math.floor(pr() * 80)}.${WEB_BRANDS[Math.floor(pr() * WEB_BRANDS.length)]}.com`;
      guard += 1;
    } while (seen.has(domain) && guard < 20);
    seen.add(domain);
    accounts.push({ id: `link${k}`, kind: 'LINK', name: domain, sub: 'Mediamonetix', weight: 0.3 + pr() });
  }
  const wSum = accounts.reduce((s, a) => s + a.weight, 0);
  accounts.forEach((a) => { a.share = a.weight / wSum; });

  const num = hashString(`${raw.id}:cid`);
  const googleShare = pr() < 0.75 ? 0.55 + pr() * 0.35 : 1;
  const adAccounts = [
    {
      id: 'g', platform: 'Google Ads', name: 'Google Ads', ref: `CID ${100 + (num % 900)}-${100 + ((num >> 8) % 900)}-${1000 + ((num >> 16) % 9000)}`, share: googleShare,
    },
  ];
  if (googleShare < 1) {
    adAccounts.push({
      id: 'm', platform: 'Meta Ads', name: 'Meta Ads', ref: `act_${10000000 + (num % 89999999)}`, share: 1 - googleShare,
    });
  }

  const nCamp = 4 + Math.floor(pr() * 3);
  const campaigns = Array.from({ length: nCamp }, (_, k) => {
    const platform = pr() < 0.65 ? 'Google Ads' : 'Meta Ads';
    const country = CAMPAIGN_COUNTRIES[Math.floor(pr() * CAMPAIGN_COUNTRIES.length)];
    const objective = OBJECTIVES[Math.floor(pr() * OBJECTIVES.length)];
    return {
      id: `${raw.id}-C${k + 1}`,
      name: `${raw.name.split(' ')[0]} · ${country} · ${objective}`,
      platform,
      country,
      status: pr() < 0.72 ? 'Active' : 'Paused',
      budget: Math.round((300 + pr() * 4700) / 10) * 10,
      spendW: 0.5 + pr(),
      cpi: round1(8 + pr() * 40),
      revF: 0.6 + pr() * 0.9,
    };
  });

  const tm = mulberry32(hashString(`${raw.id}:today`));
  const asOf = 17 * 60 + 10 + Math.floor(tm() * 40);
  const back = (max) => asOf - 1 - Math.floor(tm() * max);
  const today = {
    asOf,
    sources: [
      { name: 'Google Ads', at: back(10) },
      { name: 'Meta Ads', at: tm() < 0.5 ? null : back(15) },
      { name: 'AdMob', at: back(8) },
      { name: 'AdX', at: asOf - Math.floor(tm() * 3) },
      { name: 'Firebase', at: 13 + Math.floor(tm() * 40) },
    ],
  };

  return {
    profile, accounts, adAccounts, campaigns, today,
  };
}

function round1(n) { return Math.round(n * 10) / 10; }

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/**
 * Google Play links for an Android app, built from the app's own package name. The Paid link carries Google Ads
 * tracking parameters in `referrer`. The app has no real tracking data, so deterministic mock values are generated
 * (own seeded stream — it does not touch any other generated number).
 */
function buildStoreLinks(raw, platform) {
  if (platform !== 'Android') return null;
  const rnd = mulberry32(hashString(`${raw.id}:track`));
  const chars = (n) => Array.from({ length: n }, () => B64URL[Math.floor(rnd() * B64URL.length)]).join('');
  const pkg = `com.adnexus.${raw.pkgSlug}`;
  const base = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`;
  const campaignId = String(20000000000 + Math.floor(rnd() * 9999999999));
  const referrer = [
    ['gclid', `Cj0KCQjw${chars(88)}`],
    ['gbraid', `0AAAAA${chars(28)}`],
    ['gad_source', '3'],
    ['gad_campaignid', campaignId],
  ].map(([k, v]) => `${k}=${v}`).join('&');
  return { organic: base, paid: `${base}&referrer=${encodeURIComponent(referrer)}` };
}

function buildDays(raw, accounts, dedPct) {
  const rand = mulberry32(hashString(`${raw.id}:acctday`));
  return raw.daily.map((r) => {
    const gross = r2(r.revenueUsd / (1 - dedPct));
    const noisy = accounts.map((a) => a.share * (0.85 + rand() * 0.3));
    const ns = noisy.reduce((s, w) => s + w, 0);
    let left = gross;
    const acct = noisy.map((w, k) => {
      if (k === noisy.length - 1) return r2(left);
      const v = r2((gross * w) / ns);
      left -= v;
      return v;
    });
    const adExp = r2(r.expense / (1 + GST_RATE));
    return {
      date: r.date,
      acct,
      gross,
      ded: r2(gross - r.revenueUsd),
      netUsd: r.revenueUsd,
      income: r.revenueInr,
      adExp,
      gst: r2(r.expense - adExp),
      expense: r.expense,
      impressions: r.impressions,
      profit: r2(r.revenueInr - r.expense),
    };
  });
}

function agg(days, from, to, nAcct) {
  const o = {
    gross: 0, ded: 0, netUsd: 0, income: 0, adExp: 0, gst: 0, expense: 0, impressions: 0, profit: 0, n: 0, acct: new Array(nAcct).fill(0),
  };
  for (let i = Math.max(0, from); i <= Math.min(LAST, to); i += 1) {
    const d = days[i];
    o.gross += d.gross; o.ded += d.ded; o.netUsd += d.netUsd; o.income += d.income;
    o.adExp += d.adExp; o.gst += d.gst; o.expense += d.expense; o.impressions += d.impressions;
    o.profit += d.profit; o.n += 1;
    d.acct.forEach((v, k) => { o.acct[k] += v; });
  }
  return o;
}

function ledgerRow(label, s, extra = {}) {
  return {
    label,
    ...extra,
    adExp: r2(s.adExp),
    gst: r2(s.gst),
    expense: r2(s.expense),
    acct: s.acct.map(r2),
    ded: r2(s.ded),
    income: r2(s.income),
    profit: r2(s.profit),
    pct: s.expense ? r2((s.profit / s.expense) * 100) : null,
  };
}

function getLedger(appId) {
  const raw = getAppRaw(appId);
  if (!raw) return null;
  if (LEDGER_CACHE.has(raw.id)) return LEDGER_CACHE.get(raw.id);

  const meta = buildProfile(raw);
  const { accounts } = meta;
  const days = buildDays(raw, accounts, meta.profile.dedPct);
  const nA = accounts.length;

  // calendar months present in the history
  const months = [];
  DATES.forEach((d, i) => {
    const key = d.slice(0, 7);
    const m = months[months.length - 1];
    if (m && m.key === key) m.to = i; else months.push({ key, from: i, to: i });
  });
  const years = [...new Set(months.map((m) => m.key.slice(0, 4)))];

  const yearly = years.map((y) => {
    const ms = months.filter((m) => m.key.startsWith(y));
    return ledgerRow(y, agg(days, ms[0].from, ms[ms.length - 1].to, nA), { year: y });
  });
  yearly.push(ledgerRow('Lifetime', agg(days, 0, LAST, nA), { isTotal: true }));

  const monthlyByYear = {};
  years.forEach((y) => {
    const ms = months.filter((m) => m.key.startsWith(y));
    const rows = ms.map((m) => ledgerRow(mmyyyy(m.key), agg(days, m.from, m.to, nA), { key: m.key }));
    rows.push(ledgerRow(`${y} total`, agg(days, ms[0].from, ms[ms.length - 1].to, nA), { isTotal: true }));
    monthlyByYear[y] = rows;
  });

  const dailyByMonth = {};
  months.forEach((m) => {
    const [y, mo] = m.key.split('-').map(Number);
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const rows = [];
    for (let day = 1; day <= dim; day += 1) {
      const date = `${m.key}-${String(day).padStart(2, '0')}`;
      const i = idxOf(date);
      rows.push(i >= 0
        ? ledgerRow(ddmmyyyy(date), agg(days, i, i, nA), { date })
        : { label: ddmmyyyy(date), date, empty: true });
    }
    rows.push(ledgerRow(`${mmyyyy(m.key)} total`, agg(days, m.from, m.to, nA), { isTotal: true }));
    dailyByMonth[m.key] = rows;
  });

  const ledger = {
    raw,
    ...meta,
    days,
    months,
    years,
    yearly,
    monthlyByYear,
    dailyByMonth,
    monthOptions: months.map((m) => ({ key: m.key, label: m.key })),
    columns: accounts.map((a) => ({
      id: a.id, kind: a.kind, name: a.name, sub: a.sub,
    })),
    websites: accounts.filter((a) => a.kind === 'LINK').map((a) => a.name),
  };
  LEDGER_CACHE.set(raw.id, ledger);
  return ledger;
}

/** Ledger tables, header info and account columns for one app (independent of the date range). */
export function getAppLedger(appId) {
  const l = getLedger(appId);
  if (!l) return null;
  const { profile } = l;
  return {
    header: {
      idNumber: String(l.raw.id).replace('APP-', ''),
      name: l.raw.name,
      packageName: `com.adnexus.${l.raw.pkgSlug}`,
      platform: profile.platform,
      organic: profile.organic,
      paid: true,
      partner: profile.partner,
      storeLinks: buildStoreLinks(l.raw, profile.platform),
      status: l.raw.status,
    },
    today: l.today,
    columns: l.columns,
    dedPct: profile.dedPct,
    dedFeePct: profile.dedFeePct,
    yearly: l.yearly,
    monthlyByYear: l.monthlyByYear,
    dailyByMonth: l.dailyByMonth,
    years: l.years,
    monthOptions: l.monthOptions,
    websites: l.websites,
  };
}

// ─── range-dependent report ────────────────────────────────────────────────

const money = (n) => `₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
const signed = (n) => `${n < 0 ? '−' : '+'}${money(n)}`;
const REPORT_CACHE = new Map();

/** Cards, pulse, insights, accounts, campaigns and projection for one app and date range. */
export function getAppReport(appId, rangeId) {
  const info = getRangeInfo(rangeId);
  const l = getLedger(appId);
  if (!l) return null;
  const key = `${l.raw.id}|${info.id}`;
  if (REPORT_CACHE.has(key)) return REPORT_CACHE.get(key);

  const { days, accounts } = l;
  const nA = accounts.length;
  const [a, b] = info.cur;
  const cur = agg(days, a, b, nA);
  const roas = cur.expense ? cur.income / cur.expense : 0;
  const dedInr = Math.round(cur.ded * USD_TO_INR);
  const pctOnExpense = cur.expense ? (cur.profit / cur.expense) * 100 : null;

  const sparkIdx = Array.from({ length: Math.min(12, b - a + 1) }, (_, i) => (
    b - a + 1 <= 12 ? a + i : a + Math.round((i * (b - a)) / 11)));
  const cards = {
    rangeLabel: info.label,
    profit: r2(cur.profit),
    profitPct: pctOnExpense === null ? null : r2(pctOnExpense),
    expense: r2(cur.expense),
    adExp: r2(cur.adExp),
    gst: r2(cur.gst),
    incomeAfter: r2(cur.income),
    incomeBefore: r2(cur.income + dedInr),
    deductionInr: dedInr,
    deductionUsd: r2(cur.ded),
    roas: r2(roas),
    roasSpark: sparkIdx.map((i) => ({ v: days[i].expense ? r2(days[i].income / days[i].expense) : 0 })),
  };

  const signal = signalFor({ status: l.raw.status, roas, profit: cur.profit });
  const pulse = {
    profit: r2(cur.profit),
    spend: r2(cur.expense),
    revenue: r2(cur.income),
    roas: r2(roas),
    activeDays: cur.n,
    signal,
    spanLabel: info.spanLabel,
    rangeLabel: info.label,
  };

  // insights: analysis window = selected range when ≥ 7 days, else the trailing 30 days
  const wide = info.days >= 7;
  const [wa, wb] = wide ? [a, b] : [LAST - 29, LAST];
  const win = agg(days, wa, wb, nA);
  const winRoas = win.expense ? win.income / win.expense : 0;
  let best = days[wa];
  let worst = days[wa];
  for (let i = wa; i <= wb; i += 1) {
    if (days[i].profit > best.profit) best = days[i];
    if (days[i].profit < worst.profit) worst = days[i];
  }
  const monthKey = DATES[LAST].slice(0, 7);
  const mStart = idxOf(`${monthKey}-01`);
  const mtd = agg(days, mStart, LAST, nA);
  const last7 = agg(days, LAST - 6, LAST, nA);
  const [yy, mm] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const daysLeft = daysInMonth - (LAST - mStart + 1);
  const avg7 = last7.profit / 7;
  const projected = mtd.profit + avg7 * daysLeft;
  const topAcct = win.acct.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);
  const topShare = win.gross ? (win.acct[topAcct] / win.gross) * 100 : 0;
  const yearKey = DATES[b].slice(0, 4);
  const yearMonths = l.monthlyByYear[yearKey].filter((m) => !m.isTotal);
  const bestM = yearMonths.reduce((x, y) => (y.profit > x.profit ? y : x), yearMonths[0]);
  const worstM = yearMonths.reduce((x, y) => (y.profit < x.profit ? y : x), yearMonths[0]);
  const winSpan = wide ? info.spanLabel : 'Last 30 days';

  const insights = [
    {
      tone: win.profit >= 0 ? (winRoas >= 1.3 ? 'ok' : 'warn') : 'bad',
      title: `${winSpan}: ${win.expense ? `ROAS ${winRoas.toFixed(2)}× on ${money(win.expense)} expense` : 'No ad spend'} — profit ${signed(win.profit)}`,
      sub: `Over ${win.n} active days. Scale: ROAS ≥ 2.00 · Optimize: 1.30–2.00 · Watch: below 1.30 · Pause: loss below 0.80 or app inactive.${wide ? '' : ' (Single-day range selected, so the trailing 30 days are analysed.)'}`,
    },
    {
      tone: worst.profit < 0 ? 'warn' : 'ok',
      title: `Best day ${ddmmyyyy(best.date).slice(0, 5)} (${signed(best.profit)}), worst day ${ddmmyyyy(worst.date).slice(0, 5)} (${signed(worst.profit)})`,
      sub: 'Compare what changed in the campaign on those days.',
    },
    {
      tone: projected >= 0 ? 'ok' : 'bad',
      title: `If the last 7 days continue: about ${signed(projected)} for ${monthKey}`,
      sub: `Average ${signed(avg7)} a day × ${daysLeft} days left, plus ${signed(mtd.profit)} so far. A rough guide, not a promise.`,
    },
    {
      tone: topShare > 80 ? 'warn' : 'ok',
      title: `${Math.round(topShare)}% of ${wide ? info.label.toLowerCase() : 'last 30 days'} revenue from one account`,
      sub: `${accounts[topAcct].name}. If that account has a problem, this app's revenue stops.`,
    },
    {
      tone: bestM && worstM && worstM.profit < 0 ? 'warn' : 'ok',
      title: `${yearKey}: best month ${bestM.key} (${signed(bestM.profit)}), worst month ${worstM.key} (${signed(worstM.profit)})`,
      sub: `${yearMonths.length} active month${yearMonths.length === 1 ? '' : 's'} this year.`,
    },
  ];

  // accounts tab (window)
  const accountRows = accounts.map((ac, k) => ({
    kind: ac.kind,
    name: ac.name,
    sub: ac.sub,
    gross: r2(cur.acct[k]),
    share: cur.gross ? r2((cur.acct[k] / cur.gross) * 100) : 0,
    deduction: r2(cur.ded * (cur.gross ? cur.acct[k] / cur.gross : 0)),
    netInr: r2(cur.income * (cur.gross ? cur.acct[k] / cur.gross : 0)),
    status: l.raw.status === 'Inactive' ? 'Inactive' : 'Active',
  }));
  const adAccountRows = l.adAccounts.map((ac) => ({
    platform: ac.platform,
    ref: ac.ref,
    share: r2(ac.share * 100),
    adExp: r2(cur.adExp * ac.share),
    gst: r2(cur.gst * ac.share),
    total: r2(cur.expense * ac.share),
  }));

  // campaigns (window): spend sums to the window's ad expense, attributed revenue to its income
  const spendTot = l.campaigns.reduce((s, c) => s + c.spendW, 0);
  const revTot = l.campaigns.reduce((s, c) => s + (c.spendW / spendTot) * c.revF, 0);
  const campaigns = l.campaigns.map((c) => {
    const spend = cur.adExp * (c.spendW / spendTot);
    const revenue = cur.income * (((c.spendW / spendTot) * c.revF) / revTot);
    return {
      id: c.id,
      name: c.name,
      platform: c.platform,
      country: c.country,
      status: c.status,
      budget: c.budget,
      spend: r2(spend),
      installs: Math.round(spend / c.cpi),
      cpi: c.cpi,
      revenue: r2(revenue),
      roas: spend ? r2(revenue / spend) : 0,
    };
  });

  // projection (independent of range): current-month actuals + run-rate for the remaining days
  const actual = [];
  for (let i = mStart; i <= LAST; i += 1) {
    actual.push({
      label: ddmmyyyy(DATES[i]).slice(0, 5), revenue: days[i].income, expense: days[i].expense, profit: days[i].profit, projected: false,
    });
  }
  const avgInc7 = last7.income / 7;
  const avgExp7 = last7.expense / 7;
  const chart = [...actual];
  for (let d = 1; d <= daysLeft; d += 1) {
    chart.push({
      label: `${String(LAST - mStart + 1 + d).padStart(2, '0')}-${String(mm).padStart(2, '0')}`,
      revenue: r2(avgInc7), expense: r2(avgExp7), profit: r2(avgInc7 - avgExp7), projected: true,
    });
  }
  const trail30 = agg(days, LAST - 29, LAST, nA);
  const gr = mulberry32(hashString(`${l.raw.id}:growth`));
  let growth = 1;
  const nextMonths = [1, 2, 3].map((k) => {
    const d = new Date(Date.UTC(yy, mm - 1 + k, 1));
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    growth *= 0.985 + gr() * 0.04;
    const rev = (trail30.income / 30) * dim * growth;
    const exp = (trail30.expense / 30) * dim * growth;
    return {
      month: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      revenue: r2(rev),
      expense: r2(exp),
      profit: r2(rev - exp),
      roas: exp ? r2(rev / exp) : 0,
    };
  });
  const projection = {
    monthKey,
    mtd: { revenue: r2(mtd.income), expense: r2(mtd.expense), profit: r2(mtd.profit) },
    runRate: { revenue: r2(avgInc7), expense: r2(avgExp7), profit: r2(avgInc7 - avgExp7) },
    projectedEnd: {
      revenue: r2(mtd.income + avgInc7 * daysLeft),
      expense: r2(mtd.expense + avgExp7 * daysLeft),
      profit: r2(projected),
    },
    daysLeft,
    chart,
    nextMonths,
  };

  const report = {
    rangeId: info.id,
    cards,
    pulse,
    insights,
    accountRows,
    adAccountRows,
    campaigns,
    projection,
  };
  REPORT_CACHE.set(key, report);
  return report;
}
