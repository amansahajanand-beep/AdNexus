/**
 * Shared ROI table / summary helpers for Roi page and Presets live preview.
 */

export function formatRoiMoney(n, currency = 'USD') {
  const v = Number(n) || 0;
  const cur = String(currency || 'USD').trim().toUpperCase();
  if (cur === 'INR') {
    return `₹${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (cur && cur !== 'USD') {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: cur,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(v);
    } catch {
      return `${cur} ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  }
  return `US$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact money for KPI cards — e.g. ₹44.6k. Hover shows full via title. */
export function formatRoiMoneyCompact(n, currency = 'USD') {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs < 1000) return formatRoiMoney(n, currency);

  const cur = String(currency || 'USD').trim().toUpperCase();
  const sign = v < 0 ? '-' : '';
  const prefix = cur === 'INR' ? '₹' : (cur && cur !== 'USD' ? `${cur} ` : 'US$');

  let scaled;
  let suffix;
  if (abs >= 1_000_000) {
    scaled = abs / 1_000_000;
    suffix = 'M';
  } else {
    scaled = abs / 1000;
    suffix = 'k';
  }
  const digits = scaled >= 100 ? 0 : 1;
  const body = scaled.toFixed(digits).replace(/\.0$/, '');
  return `${sign}${prefix}${body}${suffix}`;
}

export function formatRoiPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

export function formatRoiNum(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

export function formatRoiEcpm(n, currency = 'USD') {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return formatRoiMoney(n, currency);
}

export function formatRoiEcpmCompact(n, currency = 'USD') {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return formatRoiMoneyCompact(n, currency);
}

/** Sum App vs Site earn from country×target breakdown (display currency). */
export function sumInventoryEarnFromBreakdown(countryTargetBreakdown = []) {
  let appEarn = 0;
  let siteEarn = 0;
  for (const r of countryTargetBreakdown || []) {
    const earn = Number(r.earn) || 0;
    if (!(earn > 0) && earn !== 0) continue;
    if (r.targetType === 'site' || r.earnOnly) siteEarn += earn;
    else appEarn += earn;
  }
  appEarn = Math.round(appEarn * 100) / 100;
  siteEarn = Math.round(siteEarn * 100) / 100;
  return {
    appEarn,
    siteEarn,
    totalEarn: Math.round((appEarn + siteEarn) * 100) / 100,
  };
}

export function roiToneClass(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  return Number(n) >= 0 ? 'roi-pos' : 'roi-neg';
}

export function buildRoiTableRows(rows = []) {
  return (rows || []).map((r) => ({
    ...r,
    date: r.date || '—',
    targetLabel:
      r.targetType === 'unmapped'
        ? `Unmapped Ads · ${r.targetKey || 'account'}`
        : `${r.targetType || '—'}: ${r.targetKey || '—'}`,
    revenueDollars: true,
  }));
}

export function buildRoiTableColumns(accounts = []) {
  const cols = [
    {
      id: 'date',
      type: 'dimension',
      label: 'Date',
      cellClass: '',
      getValue: (r) => r.date || '—',
      aggregate: 'label',
    },
    {
      id: 'targetLabel',
      type: 'dimension',
      label: 'Site / App',
      cellClass: '',
      getValue: (r) => r.targetLabel || `${r.targetType}: ${r.targetKey}`,
      aggregate: 'label',
    },
  ];
  (accounts || []).forEach((a) => {
    const id = `acc_${a.id}`;
    cols.push({
      id,
      type: 'metric',
      label: a.name || a.customerId || id,
      cellClass: '',
      getValue: (r) => Number(r.spendByAccount?.[a.id]) || 0,
      format: 'money',
      aggregate: 'sum',
    });
  });
  cols.push(
    {
      id: 'adsSpend',
      type: 'metric',
      label: 'Ads spend',
      getValue: (r) => Number(r.adsSpend) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'impressions',
      type: 'metric',
      label: 'Impressions',
      getValue: (r) => Number(r.impressions) || 0,
      format: 'number',
      aggregate: 'sum',
    },
    {
      id: 'clicks',
      type: 'metric',
      label: 'Clicks',
      getValue: (r) => Number(r.clicks) || 0,
      format: 'number',
      aggregate: 'sum',
    },
    {
      id: 'ctr',
      type: 'metric',
      label: 'CTR',
      getValue: (r) => (r.ctr == null ? null : Number(r.ctr)),
      format: 'percent',
      aggregate: 'none',
    },
    {
      id: 'ecpm',
      type: 'metric',
      label: 'Ads eCPM',
      getValue: (r) => (r.ecpm == null ? null : Number(r.ecpm)),
      format: 'money',
      aggregate: 'none',
    },
    {
      id: 'otherExpenses',
      type: 'metric',
      label: 'Other',
      getValue: (r) => Number(r.otherExpenses) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'earn',
      type: 'metric',
      label: 'Earn',
      getValue: (r) => Number(r.earn) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'profitSpend',
      type: 'metric',
      label: 'Profit (spend)',
      getValue: (r) => Number(r.profitSpend) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'roiSpendPercent',
      type: 'metric',
      label: 'ROI spend %',
      getValue: (r) => (r.roiSpendPercent == null ? null : Number(r.roiSpendPercent)),
      format: 'percent',
      aggregate: 'none',
      getCellClass: (r) => roiToneClass(r.roiSpendPercent),
    },
    {
      id: 'profitExpense',
      type: 'metric',
      label: 'Profit (exp.)',
      getValue: (r) => Number(r.profitExpense) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'roiExpensePercent',
      type: 'metric',
      label: 'ROI exp. %',
      getValue: (r) => (r.roiExpensePercent == null ? null : Number(r.roiExpensePercent)),
      format: 'percent',
      aggregate: 'none',
      getCellClass: (r) => roiToneClass(r.roiExpensePercent),
    },
  );
  return cols;
}

export function buildRoiSummaryGroups(summary = {}) {
  const hasOther = Number(summary.otherExpenses) > 0;
  const profitTone = Number(summary.profitSpend) >= 0 ? 'pos' : 'neg';
  const roiTone = summary.roiSpendPercent == null
    ? null
    : (Number(summary.roiSpendPercent) >= 0 ? 'pos' : 'neg');
  const spendCur = summary.adsSpendCurrency || summary.spendCurrency || 'USD';

  const moneyMetric = (key, label, amount, extra = {}) => ({
    key,
    label,
    value: formatRoiMoneyCompact(amount, spendCur),
    title: formatRoiMoney(amount, spendCur),
    ...extra,
  });

  const ads = {
    id: 'ads',
    title: 'Google Ads',
    hint: spendCur === 'INR' ? 'Account currency (matches Ads UI)' : 'From Ads sync',
    metrics: [
      moneyMetric('spend', 'Spend', summary.adsSpend, { emphasis: true }),
      {
        key: 'impressions',
        label: 'Impressions',
        value: formatRoiNum(summary.impressions),
      },
      {
        key: 'clicks',
        label: 'Clicks',
        value: formatRoiNum(summary.clicks),
      },
      {
        key: 'ctr',
        label: 'CTR',
        value: formatRoiPct(summary.ctr),
      },
      {
        key: 'ecpm',
        label: 'eCPM',
        value: formatRoiEcpmCompact(summary.ecpm, spendCur),
        title: summary.ecpm == null ? undefined : formatRoiEcpm(summary.ecpm, spendCur),
      },
    ],
  };

  const roiMetrics = [
    moneyMetric('earn', 'Earn', summary.earn, { emphasis: true }),
    moneyMetric('pSpend', 'Profit', summary.profitSpend, {
      valueTone: profitTone,
      emphasis: true,
    }),
    {
      key: 'roiSpend',
      label: 'ROI',
      value: formatRoiPct(summary.roiSpendPercent),
      valueTone: roiTone,
      emphasis: true,
    },
  ];

  if (hasOther) {
    roiMetrics.push(
      moneyMetric('other', 'Other expenses', summary.otherExpenses),
      moneyMetric('pExp', 'Profit vs expenses', summary.profitExpense, {
        valueTone: Number(summary.profitExpense) >= 0 ? 'pos' : 'neg',
      }),
      {
        key: 'roiExp',
        label: 'ROI on expenses',
        value: formatRoiPct(summary.roiExpensePercent),
        valueTone: summary.roiExpensePercent == null
          ? null
          : (Number(summary.roiExpensePercent) >= 0 ? 'pos' : 'neg'),
      },
    );
  }

  return [
    ads,
    {
      id: 'roi',
      title: 'ROI outcome',
      hint: 'Ads-linked apps only',
      metrics: roiMetrics,
    },
  ];
}

/** Flat card list (legacy / simple consumers). */
export function buildRoiSummaryCards(summary = {}) {
  return buildRoiSummaryGroups(summary).flatMap((g) => g.metrics.map((m) => ({
    ...m,
    icon: '·',
    tone: m.valueTone === 'neg' ? 'amber' : 'blue',
  })));
}

/** Convert a saved preset snapshot into roiAPI.summary query params. */
export function snapshotToRoiSummaryParams(snapshot = {}) {
  const start = snapshot.startDate;
  const end = snapshot.endDate;
  if (!start || !end) return null;

  const stripAll = (arr) => {
    const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (!list.length) return null;
    if (list.length === 1 && list[0] === '__ALL__') return null;
    const clean = list.filter((v) => v !== '__ALL__');
    return clean.length ? clean : null;
  };

  const params = {
    start,
    end,
    targetType: snapshot.targetType || 'all',
  };
  const accountIds = stripAll(snapshot.accountIds);
  const campaignIds = stripAll(snapshot.campaignIds);
  const appKeys = stripAll(snapshot.appKeys);
  const siteKeys = stripAll(snapshot.siteKeys);
  if (accountIds?.length) params.accountIds = accountIds.join(',');
  if (campaignIds?.length) params.campaignIds = campaignIds.join(',');
  if (appKeys?.length) params.appKeys = appKeys.join(',');
  if (siteKeys?.length) params.siteKeys = siteKeys.join(',');
  const countryCodes = stripAll(snapshot.countryCodes);
  if (countryCodes?.length) params.countryCodes = countryCodes.join(',');

  // App + site filters are a union — never send site-only / app-only targetType
  // (that hid Ads packages and zeroed earn when sites were selected alone).
  if (appKeys?.length || siteKeys?.length) params.targetType = 'all';

  return params;
}

/** Labels for MultiSelect options matching current selection. */
export function labelsForSelection(selected, options) {
  const list = Array.isArray(selected) ? selected.filter(Boolean) : [];
  if (!list.length) return [];
  if (list.length === 1 && list[0] === '__ALL__') return ['All'];
  const byValue = new Map(
    (options || []).map((o) => [String(o.value), o.label || String(o.value)])
  );
  return list
    .filter((v) => v !== '__ALL__')
    .map((v) => byValue.get(String(v)) || String(v));
}

export function buildCountryBreakdownColumns() {
  return [
    {
      id: 'countryLabel',
      type: 'dimension',
      label: 'Country',
      getValue: (r) => r.countryLabel || '—',
      aggregate: 'label',
    },
    {
      id: 'adsSpend',
      type: 'metric',
      label: 'Ads spend',
      getValue: (r) => Number(r.adsSpend) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'impressions',
      type: 'metric',
      label: 'Impressions',
      getValue: (r) => Number(r.impressions) || 0,
      format: 'number',
      aggregate: 'sum',
    },
    {
      id: 'clicks',
      type: 'metric',
      label: 'Clicks',
      getValue: (r) => Number(r.clicks) || 0,
      format: 'number',
      aggregate: 'sum',
    },
    {
      id: 'ctr',
      type: 'metric',
      label: 'CTR',
      getValue: (r) => (r.ctr == null ? null : Number(r.ctr)),
      format: 'percent',
      aggregate: 'none',
    },
    {
      id: 'ecpm',
      type: 'metric',
      label: 'Ads eCPM',
      getValue: (r) => (r.ecpm == null ? null : Number(r.ecpm)),
      format: 'money',
      aggregate: 'none',
    },
    {
      id: 'earn',
      type: 'metric',
      label: 'Earn',
      getValue: (r) => Number(r.earn) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'profitSpend',
      type: 'metric',
      label: 'Profit (spend)',
      getValue: (r) => Number(r.profitSpend) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'roiSpendPercent',
      type: 'metric',
      label: 'ROI spend %',
      getValue: (r) => (r.roiSpendPercent == null ? null : Number(r.roiSpendPercent)),
      format: 'percent',
      aggregate: 'none',
      getCellClass: (r) => roiToneClass(r.roiSpendPercent),
    },
  ];
}

export function buildCountryBreakdownRows(rows = []) {
  return (rows || []).map((r) => ({
    ...r,
    countryLabel: r.countryName
      ? `${r.countryName}${r.countryCode ? ` (${r.countryCode})` : ''}`
      : (r.countryCode || '—'),
    revenueDollars: true,
  }));
}

export function buildCountryTargetBreakdownRows(rows = []) {
  return (rows || []).map((r) => ({
    ...r,
    countryLabel: r.countryName
      ? `${r.countryName}${r.countryCode ? ` (${r.countryCode})` : ''}`
      : (r.countryCode || '—'),
    targetLabel: r.targetType && r.targetKey
      ? `${r.targetType}: ${r.targetKey}`
      : '—',
    revenueDollars: true,
  }));
}

function rollupCountryMetrics(items = []) {
  const adsSpend = items.reduce((s, r) => s + (Number(r.adsSpend) || 0), 0);
  const earn = items.reduce((s, r) => s + (Number(r.earn) || 0), 0);
  const otherExpenses = items.reduce((s, r) => s + (Number(r.otherExpenses) || 0), 0);
  const impressions = items.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
  const clicks = items.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  const conversions = items.reduce((s, r) => s + (Number(r.conversions) || 0), 0);
  const profitSpend = earn - adsSpend;
  const profitExpense = earn - otherExpenses;
  const roiSpendPercent = adsSpend > 0 ? (profitSpend / adsSpend) * 100 : null;
  const roiExpensePercent = otherExpenses > 0 ? (profitExpense / otherExpenses) * 100 : null;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const ecpm = impressions > 0 ? (adsSpend / impressions) * 1000 : null;
  return {
    adsSpend,
    earn,
    otherExpenses,
    profitSpend,
    profitExpense,
    roiSpendPercent,
    roiExpensePercent,
    impressions,
    clicks,
    conversions,
    ctr,
    ecpm,
  };
}

export function formatRoiDateRange(startDate = '', endDate = '') {
  const start = String(startDate || '').slice(0, 10);
  const end = String(endDate || '').slice(0, 10);
  if (start && end && start !== end) return `${start} → ${end}`;
  return start || end || '—';
}

function packageKey(row) {
  return [
    String(row.countryCode || '').toUpperCase(),
    String(row.adsAccountId || row.accountName || ''),
    String(row.targetType || ''),
    String(row.targetKey || '').toLowerCase(),
  ].join('|');
}

function sortPackages(packages = []) {
  return [...packages].sort((a, b) => {
    const aSite = a.targetType === 'site' || a.earnOnly ? 1 : 0;
    const bSite = b.targetType === 'site' || b.earnOnly ? 1 : 0;
    if (aSite !== bSite) return aSite - bSite;
    if (aSite) return b.earn - a.earn || a.label.localeCompare(b.label);
    return b.adsSpend - a.adsSpend || a.label.localeCompare(b.label);
  });
}

function finalizeAccount(acc) {
  const sortedPackages = sortPackages(acc.packages || []);
  const rolled = rollupCountryMetrics(sortedPackages);
  const appEarn = sortedPackages
    .filter((p) => p.targetType !== 'site' && !p.earnOnly)
    .reduce((s, p) => s + (Number(p.earn) || 0), 0);
  const siteEarn = sortedPackages
    .filter((p) => p.targetType === 'site' || p.earnOnly)
    .reduce((s, p) => s + (Number(p.earn) || 0), 0);
  return {
    ...acc,
    ...rolled,
    appEarn,
    siteEarn,
    packages: sortedPackages,
  };
}

function isGamSitesBucket(acc) {
  return acc?.adsAccountId === 'gam-sites'
    || String(acc?.label || '').toLowerCase() === 'gam sites';
}

/**
 * Country → (optional Ads account) → Package / Site tree.
 * - singleAccountMode: Country → Package + Site (no account / GAM sites wrapper)
 * - multi: Country → Ads account → Package + Site (sites folded into ads accounts)
 */
export function buildCountryTree(
  countryBreakdown = [],
  countryTargetBreakdown = [],
  countryTargetDailyBreakdown = [],
  { startDate = '', endDate = '', singleAccountMode = false } = {},
) {
  const rangeLabel = formatRoiDateRange(startDate, endDate);
  const targetsByCountry = new Map();
  (countryTargetBreakdown || []).forEach((row) => {
    const code = String(row.countryCode || '').trim().toUpperCase() || '—';
    if (!targetsByCountry.has(code)) targetsByCountry.set(code, []);
    targetsByCountry.get(code).push(row);
  });

  const dailyByPackage = new Map();
  (countryTargetDailyBreakdown || []).forEach((row) => {
    const key = packageKey(row);
    if (!dailyByPackage.has(key)) dailyByPackage.set(key, []);
    dailyByPackage.get(key).push({
      id: `day:${key}:${row.date}`,
      level: 'date',
      date: row.date,
      label: row.date,
      targetType: row.targetType,
      earnOnly: row.targetType === 'site' || Boolean(row.earnOnly),
      adsSpend: row.targetType === 'site' ? 0 : (Number(row.adsSpend) || 0),
      earn: Number(row.earn) || 0,
      otherExpenses: Number(row.otherExpenses) || 0,
      profitSpend: Number(row.profitSpend) || 0,
      profitExpense: Number(row.profitExpense) || 0,
      roiSpendPercent: row.targetType === 'site' ? null : row.roiSpendPercent,
      roiExpensePercent: row.roiExpensePercent,
      impressions: Number(row.impressions) || 0,
      clicks: Number(row.clicks) || 0,
      conversions: Number(row.conversions) || 0,
      ctr: row.ctr,
      ecpm: row.ecpm,
    });
  });
  dailyByPackage.forEach((days, key) => {
    days.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    dailyByPackage.set(key, days);
  });

  return (countryBreakdown || []).map((c) => {
    const code = String(c.countryCode || '').trim().toUpperCase() || '—';
    const countryLabel = c.countryName
      ? `${c.countryName}${c.countryCode ? ` (${c.countryCode})` : ''}`
      : (c.countryCode || '—');
    const targetRows = targetsByCountry.get(code) || [];
    const accountsMap = new Map();

    targetRows.forEach((row) => {
      const isSite = row.targetType === 'site' || Boolean(row.earnOnly);
      const accId = String(row.adsAccountId || row.accountName || 'unknown');
      if (!accountsMap.has(accId)) {
        accountsMap.set(accId, {
          id: `acc:${code}:${accId}`,
          level: 'account',
          adsAccountId: row.adsAccountId,
          label: row.accountName || '—',
          dateLabel: rangeLabel,
          packages: [],
        });
      }
      const acc = accountsMap.get(accId);
      const pKey = packageKey(row);
      const days = dailyByPackage.get(pKey) || [];
      const dayLabel = days.length === 1
        ? days[0].date
        : rangeLabel;
      const earn = Number(row.earn) || 0;
      const adsSpend = isSite ? 0 : (Number(row.adsSpend) || 0);
      acc.packages.push({
        id: `pkg:${code}:${accId}:${row.targetType || 'x'}:${row.targetKey || 'x'}`,
        level: isSite ? 'site' : 'package',
        label: row.targetKey || '—',
        targetType: row.targetType,
        targetKey: row.targetKey,
        earnOnly: isSite,
        dateLabel: dayLabel,
        days,
        adsSpend,
        earn,
        otherExpenses: Number(row.otherExpenses) || 0,
        profitSpend: Number(row.profitSpend) || 0,
        profitExpense: Number(row.profitExpense) || 0,
        roiSpendPercent: isSite ? null : row.roiSpendPercent,
        roiExpensePercent: row.roiExpensePercent,
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        conversions: Number(row.conversions) || 0,
        ctr: row.ctr,
        ecpm: row.ecpm,
      });
    });

    let accounts = Array.from(accountsMap.values()).map(finalizeAccount);

    // Fold "GAM sites" bucket into Ads accounts — no separate GAM sites wrapper.
    const gamBucket = accounts.find(isGamSitesBucket);
    const adsAccounts = accounts
      .filter((a) => !isGamSitesBucket(a))
      .sort((a, b) => b.adsSpend - a.adsSpend || a.label.localeCompare(b.label));
    if (gamBucket?.packages?.length && adsAccounts.length) {
      // Fold sites into Ads accounts (no "GAM sites" wrapper).
      // Attach under the top-spend account in this country so site earn isn't duplicated.
      const host = adsAccounts[0];
      gamBucket.packages.forEach((pkg) => {
        host.packages.push({
          ...pkg,
          id: `${pkg.id}::under:${host.adsAccountId || host.id}`,
        });
      });
      accounts = adsAccounts.map(finalizeAccount);
    } else if (gamBucket?.packages?.length && !adsAccounts.length) {
      accounts = [];
    } else {
      accounts = adsAccounts.length ? adsAccounts : accounts.filter((a) => !isGamSitesBucket(a));
    }
    accounts = accounts.sort((a, b) => b.adsSpend - a.adsSpend || a.label.localeCompare(b.label));

    const orphanSitePackages = (!adsAccounts.length && gamBucket?.packages) ? gamBucket.packages : [];
    const allPackages = sortPackages(
      accounts.length
        ? accounts.flatMap((a) => a.packages || [])
        : orphanSitePackages
    );

    // Deduplicate packages/sites (same site may appear under multiple accounts).
    const dedupePackages = (list) => {
      const seen = new Set();
      const out = [];
      for (const pkg of list || []) {
        const key = `${pkg.targetType || ''}:${String(pkg.targetKey || pkg.label || '').toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(pkg);
      }
      return sortPackages(out);
    };

    const uniquePackages = dedupePackages(allPackages);
    const useFlat = Boolean(singleAccountMode || accounts.length <= 1);
    const flatPackages = useFlat ? uniquePackages : [];
    const countryExpense = Number(c.otherExpenses);
    const countryProfitExpense = Number(c.profitExpense);
    const rolled = rollupCountryMetrics(useFlat ? flatPackages : accounts);
    // Country earn split always from unique packages (sites are not double-counted).
    const appEarn = uniquePackages
      .filter((p) => p.targetType !== 'site' && !p.earnOnly)
      .reduce((s, p) => s + (Number(p.earn) || 0), 0);
    const siteEarn = uniquePackages
      .filter((p) => p.targetType === 'site' || p.earnOnly)
      .reduce((s, p) => s + (Number(p.earn) || 0), 0);

    return {
      id: `country:${code}`,
      level: 'country',
      countryCode: code,
      countryName: c.countryName,
      label: countryLabel,
      dateLabel: rangeLabel,
      adsSpend: Number(c.adsSpend) || 0,
      earn: Number(c.earn) || 0,
      appEarn,
      siteEarn,
      otherExpenses: Number.isFinite(countryExpense) ? countryExpense : rolled.otherExpenses,
      profitSpend: Number(c.profitSpend) || 0,
      profitExpense: Number.isFinite(countryProfitExpense) ? countryProfitExpense : rolled.profitExpense,
      roiSpendPercent: c.roiSpendPercent,
      roiExpensePercent: c.roiExpensePercent != null ? c.roiExpensePercent : rolled.roiExpensePercent,
      impressions: Number(c.impressions) || 0,
      clicks: Number(c.clicks) || 0,
      conversions: Number(c.conversions) || 0,
      ctr: c.ctr,
      ecpm: c.ecpm,
      flatMode: useFlat,
      packages: useFlat ? flatPackages : [],
      accounts: useFlat ? [] : accounts,
      accountCount: useFlat ? 0 : accounts.length,
      childCount: useFlat ? (flatPackages?.length || 0) : accounts.length,
    };
  }).sort((a, b) => b.adsSpend - a.adsSpend || a.label.localeCompare(b.label));
}

/** Flatten tree for CSV / Excel export (full hierarchy). */
export function flattenCountryTreeForExport(tree = []) {
  const rows = [];
  const push = (level, name, date, m) => {
    rows.push({
      level,
      name,
      date,
      adsSpend: m.adsSpend,
      impressions: m.impressions,
      clicks: m.clicks,
      ctr: m.ctr,
      ecpm: m.ecpm,
      earn: m.earn,
      otherExpenses: m.otherExpenses,
      profitSpend: m.profitSpend,
      profitExpense: m.profitExpense,
      roiSpendPercent: m.roiSpendPercent,
      roiExpensePercent: m.roiExpensePercent,
    });
  };
  (tree || []).forEach((country) => {
    push('Country', country.label, country.dateLabel, country);
    if (country.flatMode && (country.packages || []).length) {
      (country.packages || []).forEach((pkg) => {
        push(pkg.targetType === 'site' || pkg.earnOnly ? 'Site' : 'Package', pkg.label, pkg.dateLabel, pkg);
        (pkg.days || []).forEach((day) => {
          push('Date', pkg.label, day.date, day);
        });
      });
      return;
    }
    (country.accounts || []).forEach((account) => {
      push('Ads account', account.label, account.dateLabel, account);
      (account.packages || []).forEach((pkg) => {
        push(pkg.targetType === 'site' || pkg.earnOnly ? 'Site' : 'Package', pkg.label, pkg.dateLabel, pkg);
        (pkg.days || []).forEach((day) => {
          push('Date', pkg.label, day.date, day);
        });
      });
    });
  });
  return rows;
}

export function filterCountryTree(tree = [], query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return tree;
  return (tree || []).filter((country) => {
    if (country.label.toLowerCase().includes(q)) return true;
    if (String(country.dateLabel || '').toLowerCase().includes(q)) return true;
    if ((country.packages || []).some((pkg) => {
      if (pkg.label.toLowerCase().includes(q)) return true;
      return (pkg.days || []).some((day) => String(day.date || '').includes(q));
    })) return true;
    return (country.accounts || []).some((account) => {
      if (account.label.toLowerCase().includes(q)) return true;
      return (account.packages || []).some((pkg) => {
        if (pkg.label.toLowerCase().includes(q)) return true;
        return (pkg.days || []).some((day) => String(day.date || '').includes(q));
      });
    });
  });
}

export function buildCountryTargetBreakdownColumns() {
  return [
    {
      id: 'accountName',
      type: 'dimension',
      label: 'Ads account',
      getValue: (r) => r.accountName || '—',
      aggregate: 'label',
    },
    {
      id: 'targetLabel',
      type: 'dimension',
      label: 'Site / App',
      getValue: (r) => r.targetLabel || '—',
      aggregate: 'label',
    },
    {
      id: 'countryLabel',
      type: 'dimension',
      label: 'Country',
      getValue: (r) => r.countryLabel || '—',
      aggregate: 'label',
    },
    {
      id: 'adsSpend',
      type: 'metric',
      label: 'Ads spend',
      getValue: (r) => Number(r.adsSpend) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'earn',
      type: 'metric',
      label: 'Earn',
      getValue: (r) => Number(r.earn) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'profitSpend',
      type: 'metric',
      label: 'Profit (spend)',
      getValue: (r) => Number(r.profitSpend) || 0,
      format: 'money',
      aggregate: 'sum',
    },
    {
      id: 'roiSpendPercent',
      type: 'metric',
      label: 'ROI spend %',
      getValue: (r) => (r.roiSpendPercent == null ? null : Number(r.roiSpendPercent)),
      format: 'percent',
      aggregate: 'none',
      getCellClass: (r) => roiToneClass(r.roiSpendPercent),
    },
  ];
}

/**
 * Merge summaryOnly + breakdownOnly API payloads without clobbering each other.
 * breakdownOnly returns empty `summary` / `accounts`; a naive `{...prev, ...bd}`
 * wipe caused overview cards to show $0 while the country table still had data.
 */
export function summaryFromCountryBreakdown(countryBreakdown = []) {
  const rows = Array.isArray(countryBreakdown) ? countryBreakdown : [];
  if (!rows.length) return null;
  let adsSpend = 0;
  let earn = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  rows.forEach((r) => {
    adsSpend += Number(r.adsSpend) || 0;
    earn += Number(r.earn) || 0;
    impressions += Number(r.impressions) || 0;
    clicks += Number(r.clicks) || 0;
    conversions += Number(r.conversions) || 0;
  });
  adsSpend = Math.round(adsSpend * 100) / 100;
  earn = Math.round(earn * 100) / 100;
  const profitSpend = Math.round((earn - adsSpend) * 100) / 100;
  const roiSpendPercent = adsSpend > 0
    ? Math.round(((earn - adsSpend) / adsSpend) * 10000) / 100
    : null;
  const ctr = impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : null;
  const ecpm = impressions > 0 ? Math.round((adsSpend / impressions) * 1000 * 100) / 100 : null;
  return {
    adsSpend,
    otherExpenses: 0,
    totalCost: adsSpend,
    earn,
    profitSpend,
    profitExpense: earn,
    profit: profitSpend,
    roiSpendPercent,
    roiExpensePercent: null,
    roiPercent: roiSpendPercent,
    impressions,
    clicks,
    conversions,
    ctr,
    ecpm,
    mappedSpend: adsSpend,
    unmappedSpend: 0,
    mappedCampaigns: 0,
    accountsWithSpend: 0,
    _fromBreakdown: true,
  };
}

export function mergeRoiSummaryPayload(prev, summaryPayload) {
  if (!summaryPayload) return prev;
  const next = { ...(prev || {}) };
  if (summaryPayload.summary && typeof summaryPayload.summary === 'object'
    && Object.keys(summaryPayload.summary).length > 0) {
    next.summary = summaryPayload.summary;
  }
  if (Array.isArray(summaryPayload.accounts) && summaryPayload.accounts.length > 0) {
    next.accounts = summaryPayload.accounts;
  } else if (!Array.isArray(next.accounts)) {
    next.accounts = [];
  }
  if (Array.isArray(summaryPayload.rows)) next.rows = summaryPayload.rows;
  if (Array.isArray(summaryPayload.generalExpenses)) {
    next.generalExpenses = summaryPayload.generalExpenses;
  }
  if (Array.isArray(summaryPayload.expenses)) next.expenses = summaryPayload.expenses;
  if (summaryPayload.spendCurrency) next.spendCurrency = summaryPayload.spendCurrency;
  if (next.summary && summaryPayload.spendCurrency && !next.summary.adsSpendCurrency) {
    next.summary = { ...next.summary, adsSpendCurrency: summaryPayload.spendCurrency };
  }
  return next;
}

export function mergeRoiBreakdownPayload(prev, breakdownPayload) {
  if (!breakdownPayload) return prev;
  const next = {
    ...(prev || {}),
    countryBreakdown: Array.isArray(breakdownPayload.countryBreakdown)
      ? breakdownPayload.countryBreakdown
      : (prev?.countryBreakdown || []),
    countryTargetBreakdown: Array.isArray(breakdownPayload.countryTargetBreakdown)
      ? breakdownPayload.countryTargetBreakdown
      : (prev?.countryTargetBreakdown || []),
    countryTargetDailyBreakdown: Array.isArray(breakdownPayload.countryTargetDailyBreakdown)
      ? breakdownPayload.countryTargetDailyBreakdown
      : (prev?.countryTargetDailyBreakdown || []),
  };
  // Fill overview immediately from the table while summaryOnly is still in flight.
  const hasSummary = next.summary && Object.keys(next.summary).length > 0
    && !next.summary._fromBreakdown;
  if (!hasSummary) {
    const interim = summaryFromCountryBreakdown(next.countryBreakdown);
    if (interim) next.summary = interim;
  }
  return next;
}
