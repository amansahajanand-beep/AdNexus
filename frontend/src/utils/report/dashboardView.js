import { normalizeInventorySelections } from '../inventorySelection';

function hasAnyInventory(inv = {}) {
  return Boolean(
    (inv.domain || []).length
    || (inv.site || []).length
    || (inv.domainName || []).length
    || (inv.domainId || []).length
  );
}

/**
 * Build API filter objects for Dashboard overview + detail from a preset snapshot.
 */
export function snapshotToDashboardParams(snapshot = {}) {
  const startDate = snapshot.startDate;
  const endDate = snapshot.endDate;
  if (!startDate || !endDate) return null;

  const inv = normalizeInventorySelections({
    domain: snapshot.domain,
    site: snapshot.site,
    domainName: snapshot.domainName,
    domainId: snapshot.domainId,
  }, {});

  const filterApplied = hasAnyInventory(inv);
  const overview = { startDate, endDate };
  if (filterApplied) {
    if (inv.domain?.length) overview.domain = inv.domain;
    if (inv.site?.length) overview.site = inv.site;
    if (inv.domainName?.length) overview.domainName = inv.domainName;
    if (inv.domainId?.length) overview.domainId = inv.domainId;
  }

  return {
    startDate,
    endDate,
    overview,
    detail: {
      startDate,
      endDate,
      domain: inv.domain || [],
      site: inv.site || [],
      domainName: inv.domainName || [],
      domainId: inv.domainId || [],
    },
    applied: {
      startDate,
      endDate,
      domain: inv.domain || [],
      site: inv.site || [],
      domainName: inv.domainName || [],
      domainId: inv.domainId || [],
    },
    filterApplied,
  };
}
