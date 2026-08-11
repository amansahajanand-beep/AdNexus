import { DEFAULT_REPORT_METRICS } from './gamReportCatalog';
import { DASHBOARD_DEFAULT_METRICS } from './dynamicReportTable';
import { draftHasInventorySelection } from './assignedInventoryFilters';

function asFilterArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '');
  return v ? [v] : [];
}

function hasManualReportSelection(applied = {}) {
  return Boolean(
    applied.reportDimensions?.length
    || applied.reportMetrics?.length
    || applied.domain?.length
    || applied.site?.length
    || applied.domainName?.length
    || applied.domainId?.length
    || asFilterArray(applied.country).length
  );
}

/** User chose something beyond date range — required before loading Reporting data. */
export function hasReportSelection(applied = {}) {
  return hasManualReportSelection(applied);
}

/** Table dimensions for inventory-only reports — mirrors Dashboard breakdown columns. */
export function inventoryFilterTableDims(applied = {}) {
  const dims = ['date'];
  if (asFilterArray(applied.country).length) dims.push('country_name');
  if (applied.domain?.length) dims.push('domain');
  if (applied.site?.length) dims.push('site_name');
  if (applied.domainName?.length) dims.push('ad_unit_name');
  if (applied.domainId?.length) {
    dims.push('mobile_app_resolved_id');
    dims.push('mobile_app_name');
  }
  return dims;
}

/**
 * Resolve GAM query dims/metrics for /reports/detailed.
 * Date-only (nothing selected) → default overview: Date + Total revenue (+ impressions)
 * so summary cards always have values.
 *
 * Site/App/Ad unit filters without Report Builder dimensions still need table dims
 * (date + site_name / app id / …). If the user picked metrics but left dimensions
 * empty, fall back to those inventory dims so GAM returns filterable rows.
 */
export function resolveReportingQuery(applied = {}) {
  const userDims = applied.reportDimensions || [];
  const userMets = applied.reportMetrics || [];
  const invDims = inventoryFilterTableDims(applied);
  const hasInv = draftHasInventorySelection(applied);

  // Nothing selected beyond date → still load Total Revenue overview for cards.
  if (!hasReportSelection(applied)) {
    return {
      dims: ['date'],
      mets: [...DEFAULT_REPORT_METRICS],
      tableDims: ['date'],
    };
  }

  if (userDims.length || userMets.length) {
    // Metrics-only + inventory filters → still request site/app breakdown dims.
    const dims = userDims.length
      ? userDims
      : (hasInv ? invDims : ['date']);
    return {
      dims,
      mets: userMets.length ? userMets : [...DEFAULT_REPORT_METRICS],
      tableDims: dims,
    };
  }

  return {
    // Inventory-only: backend picks reliable dimension sets; UI still shows inv columns.
    dims: hasInv ? [] : invDims,
    mets: [...DASHBOARD_DEFAULT_METRICS],
    tableDims: invDims,
  };
}
