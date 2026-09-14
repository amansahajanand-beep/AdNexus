import { DEFAULT_REPORT_METRICS } from './gamReportCatalog';
import { draftHasInventorySelection } from '../filters/assignedInventoryFilters';

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

/** Table dimensions from inventory filters the user actually applied. */
export function inventoryFilterTableDims(applied = {}) {
  const hasApp = asFilterArray(applied.domainId).length > 0;
  const hasDomain = asFilterArray(applied.domain).length > 0;
  const hasSite = asFilterArray(applied.site).length > 0;
  const hasAdUnit = asFilterArray(applied.domainName).length > 0;
  const hasCountry = asFilterArray(applied.country).length > 0;
  const hasWeb = hasDomain || hasSite || hasAdUnit;

  const dimensions = ['date'];
  if (hasCountry) dimensions.push('country_name');

  // App-only: do NOT inject Domain/Site — that forced web∪app unions and hid app×country.
  if (hasWeb || !hasApp) {
    if (hasDomain || !hasApp) dimensions.push('domain');
    if (hasSite || !hasApp) dimensions.push('site_name');
  }
  if (hasAdUnit) dimensions.push('ad_unit_name');
  if (hasApp) {
    dimensions.push('mobile_app_resolved_id');
    dimensions.push('mobile_app_name');
  }
  return [...new Set(dimensions)];
}

/**
 * Resolve GAM query dims/metrics for /reports/detailed.
 * Date-only (nothing selected) → Date + Domain + Site + default metrics
 * so summary cards and the table always have values.
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
  const defaultDims = ['date', 'domain', 'site_name'];

  // Nothing selected beyond date → load default domain+site overview.
  if (!hasReportSelection(applied)) {
    return {
      dims: defaultDims,
      mets: [...DEFAULT_REPORT_METRICS],
      tableDims: defaultDims,
    };
  }

  if (userDims.length || userMets.length) {
    // Metrics-only + inventory filters → still request site/app breakdown dims.
    let dims = userDims.length
      ? [...userDims]
      : (hasInv ? invDims : defaultDims);
    // Country filter must keep country_name so the table does not roll countries away.
    if (asFilterArray(applied.country).length && !dims.includes('country_name')) {
      dims = [...dims, 'country_name'];
    }
    // App-only inventory: drop sticky default Domain/Site so we stay on app_id×country.
    if (
      asFilterArray(applied.domainId).length
      && !asFilterArray(applied.domain).length
      && !asFilterArray(applied.site).length
      && !asFilterArray(applied.domainName).length
    ) {
      dims = dims.filter((d) => d !== 'domain' && d !== 'site_name' && d !== 'url_name');
      if (!dims.includes('mobile_app_resolved_id')) dims.push('mobile_app_resolved_id');
      if (!dims.includes('mobile_app_name')) dims.push('mobile_app_name');
      if (!dims.includes('date')) dims = ['date', ...dims];
    }
    return {
      dims,
      mets: userMets.length ? userMets : [...DEFAULT_REPORT_METRICS],
      tableDims: dims,
    };
  }

  return {
    // Inventory-only: backend picks warehouse grain; UI shows domain + site (+ filter cols).
    dims: hasInv ? invDims : defaultDims,
    mets: [...DEFAULT_REPORT_METRICS],
    tableDims: invDims,
  };
}
