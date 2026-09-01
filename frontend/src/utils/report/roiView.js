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

export function buildRoiSummaryCards(summary = {}) {
  return [
    {
      key: 'spend',
      label: 'Ads spend',
      value: formatRoiMoney(summary.adsSpend),
      icon: '💸',
      tone: 'blue',
    },
    {
      key: 'other',
      label: 'Other expenses',
      value: formatRoiMoney(summary.otherExpenses),
      icon: '📄',
      tone: 'amber',
    },
    {
      key: 'earn',
      label: 'Earn',
      value: formatRoiMoney(summary.earn),
      icon: '💰',
      tone: 'green',
    },
    {
      key: 'pSpend',
      label: 'Profit (vs spend)',
      value: formatRoiMoney(summary.profitSpend),
      icon: '📈',
      tone: 'green',
    },
    {
      key: 'roiSpend',
      label: 'ROI on spend',
      value: formatRoiPct(summary.roiSpendPercent),
      icon: '%',
      tone: 'green',
    },
    {
      key: 'pExp',
      label: 'Profit (vs expenses)',
      value: formatRoiMoney(summary.profitExpense),
      icon: '📈',
      tone: 'amber',
    },
    {
      key: 'roiExp',
      label: 'ROI on expenses',
      value: formatRoiPct(summary.roiExpensePercent),
      icon: '%',
      tone: 'green',
    },
  ];
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
  const profitSpend = earn - adsSpend;
  const roiSpendPercent = adsSpend > 0 ? (profitSpend / adsSpend) * 100 : null;
  return { adsSpend, earn, profitSpend, roiSpendPercent };
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
      accounts,
      accountCount: accounts.length,
    };
  }).sort((a, b) => b.adsSpend - a.adsSpend || a.label.localeCompare(b.label));
}

/** Flatten tree for CSV / Excel export (full hierarchy). */
export function flattenCountryTreeForExport(tree = []) {
  const rows = [];
  (tree || []).forEach((country) => {
    rows.push({
      level: 'Country',
      name: country.label,
      date: country.dateLabel,
      adsSpend: country.adsSpend,
      earn: country.earn,
      profitSpend: country.profitSpend,
      roiSpendPercent: country.roiSpendPercent,
    });
    (country.accounts || []).forEach((account) => {
      rows.push({
        level: 'Ads account',
        name: account.label,
        date: account.dateLabel,
        adsSpend: account.adsSpend,
        earn: account.earn,
        profitSpend: account.profitSpend,
        roiSpendPercent: account.roiSpendPercent,
      });
      (account.packages || []).forEach((pkg) => {
        rows.push({
          level: 'Package',
          name: pkg.label,
          date: pkg.dateLabel,
          adsSpend: pkg.adsSpend,
          earn: pkg.earn,
          profitSpend: pkg.profitSpend,
          roiSpendPercent: pkg.roiSpendPercent,
        });
        (pkg.days || []).forEach((day) => {
          rows.push({
            level: 'Date',
            name: pkg.label,
            date: day.date,
            adsSpend: day.adsSpend,
            earn: day.earn,
            profitSpend: day.profitSpend,
            roiSpendPercent: day.roiSpendPercent,
          });
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
