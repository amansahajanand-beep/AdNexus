/**
 * Shared ROI table / summary helpers for Roi page and Presets live preview.
 */

export function formatRoiMoney(n) {
  const v = Number(n) || 0;
  return `US$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatRoiPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

export function formatRoiNum(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

export function formatRoiEcpm(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return formatRoiMoney(n);
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

  const ads = {
    id: 'ads',
    title: 'Google Ads',
    hint: 'From Ads sync',
    metrics: [
      {
        key: 'spend',
        label: 'Spend',
        value: formatRoiMoney(summary.adsSpend),
        emphasis: true,
      },
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
        value: formatRoiEcpm(summary.ecpm),
      },
    ],
  };

  const roiMetrics = [
    {
      key: 'earn',
      label: 'Earn',
      value: formatRoiMoney(summary.earn),
      emphasis: true,
    },
    {
      key: 'pSpend',
      label: 'Profit',
      value: formatRoiMoney(summary.profitSpend),
      valueTone: profitTone,
      emphasis: true,
    },
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
      {
        key: 'other',
        label: 'Other expenses',
        value: formatRoiMoney(summary.otherExpenses),
      },
      {
        key: 'pExp',
        label: 'Profit vs expenses',
        value: formatRoiMoney(summary.profitExpense),
        valueTone: Number(summary.profitExpense) >= 0 ? 'pos' : 'neg',
      },
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

  // Derive targetType when apps/sites present (same as ROI apply).
  if (appKeys?.length && siteKeys?.length) params.targetType = 'all';
  else if (appKeys?.length) params.targetType = 'app';
  else if (siteKeys?.length) params.targetType = 'site';

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
  const impressions = items.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
  const clicks = items.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  const conversions = items.reduce((s, r) => s + (Number(r.conversions) || 0), 0);
  const profitSpend = earn - adsSpend;
  const roiSpendPercent = adsSpend > 0 ? (profitSpend / adsSpend) * 100 : null;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const ecpm = impressions > 0 ? (adsSpend / impressions) * 1000 : null;
  return {
    adsSpend,
    earn,
    profitSpend,
    roiSpendPercent,
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

/**
 * Country → Ads account → Package → Date tree for the ROI country table.
 */
export function buildCountryTree(
  countryBreakdown = [],
  countryTargetBreakdown = [],
  countryTargetDailyBreakdown = [],
  { startDate = '', endDate = '' } = {},
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
      adsSpend: Number(row.adsSpend) || 0,
      earn: Number(row.earn) || 0,
      profitSpend: Number(row.profitSpend) || 0,
      roiSpendPercent: row.roiSpendPercent,
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
        : (days.length > 1 ? rangeLabel : rangeLabel);
      acc.packages.push({
        id: `pkg:${code}:${accId}:${row.targetType || 'x'}:${row.targetKey || 'x'}`,
        level: 'package',
        label: row.targetKey || '—',
        targetType: row.targetType,
        targetKey: row.targetKey,
        dateLabel: dayLabel,
        days,
        adsSpend: Number(row.adsSpend) || 0,
        earn: Number(row.earn) || 0,
        profitSpend: Number(row.profitSpend) || 0,
        roiSpendPercent: row.roiSpendPercent,
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        conversions: Number(row.conversions) || 0,
        ctr: row.ctr,
        ecpm: row.ecpm,
      });
    });

    const accounts = Array.from(accountsMap.values())
      .map((acc) => {
        const sortedPackages = acc.packages.sort((a, b) => b.adsSpend - a.adsSpend || a.label.localeCompare(b.label));
        return { ...acc, ...rollupCountryMetrics(sortedPackages), packages: sortedPackages };
      })
      .sort((a, b) => b.adsSpend - a.adsSpend || a.label.localeCompare(b.label));

    return {
      id: `country:${code}`,
      level: 'country',
      countryCode: code,
      countryName: c.countryName,
      label: countryLabel,
      dateLabel: rangeLabel,
      adsSpend: Number(c.adsSpend) || 0,
      earn: Number(c.earn) || 0,
      profitSpend: Number(c.profitSpend) || 0,
      roiSpendPercent: c.roiSpendPercent,
      impressions: Number(c.impressions) || 0,
      clicks: Number(c.clicks) || 0,
      conversions: Number(c.conversions) || 0,
      ctr: c.ctr,
      ecpm: c.ecpm,
      accounts,
      accountCount: accounts.length,
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
      profitSpend: m.profitSpend,
      roiSpendPercent: m.roiSpendPercent,
    });
  };
  (tree || []).forEach((country) => {
    push('Country', country.label, country.dateLabel, country);
    (country.accounts || []).forEach((account) => {
      push('Ads account', account.label, account.dateLabel, account);
      (account.packages || []).forEach((pkg) => {
        push('Package', pkg.label, pkg.dateLabel, pkg);
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
