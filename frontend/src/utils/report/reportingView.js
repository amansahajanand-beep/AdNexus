import { normalizeInventorySelections } from '../inventorySelection';
import { resolveReportingQuery } from './reportSelection';
import { resolveReportTableConfig } from './dynamicReportTable';

/**
 * Build Reporting API filters + table config from a preset snapshot.
 */
export function snapshotToReportingParams(snapshot = {}) {
  const startDate = snapshot.startDate;
  const endDate = snapshot.endDate;
  if (!startDate || !endDate) return null;

  const inv = normalizeInventorySelections({
    domain: snapshot.domain,
    site: snapshot.site,
    domainName: snapshot.domainName,
    domainId: snapshot.domainId,
  }, {});

  const applied = {
    startDate,
    endDate,
    country: Array.isArray(snapshot.country) ? snapshot.country.filter(Boolean) : [],
    domain: inv.domain || [],
    site: inv.site || [],
    domainName: inv.domainName || [],
    domainId: inv.domainId || [],
    reportDimensions: Array.isArray(snapshot.reportDimensions) ? snapshot.reportDimensions : [],
    reportMetrics: Array.isArray(snapshot.reportMetrics) ? snapshot.reportMetrics : [],
  };

  const query = resolveReportingQuery(applied);
  if (!query) return null;

  const { dims, mets } = query;
  const tableConfig = resolveReportTableConfig(dims, mets);
  if (tableConfig.mode === 'none') return null;

  const reportFilters = {
    ...inv,
    startDate,
    endDate,
    reportDimensions: dims,
    reportMetrics: mets,
    country: applied.country,
    allRows: true,
  };

  return {
    applied,
    reportFilters,
    dims,
    mets,
    tableConfig,
  };
}

export function formatReportingMoney(n, currency = 'USD') {
  const sym = currency === 'INR' ? '\u20B9' : 'US$';
  const v = Number(n) || 0;
  return `${sym}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
