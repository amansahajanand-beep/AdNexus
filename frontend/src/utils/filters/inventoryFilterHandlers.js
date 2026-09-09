import { pruneAfterFieldChange } from './filters';

/**
 * Build onChange handlers for inventory filters.
 * When cascade is false, parent changes do not prune child selections (independent picks).
 */
export function createInventoryHandlers(catalog, getters, setters, { cascade = true } = {}) {
  const getSel = () => ({
    domain: getters.getDomain(),
    site: getters.getSite(),
    adUnit: getters.getAdUnit(),
    app: getters.getApp(),
  });

  return {
    onDomainChange: (nextDomain) => {
      setters.setDomain(nextDomain);
      if (!cascade) return;
      if (!nextDomain || nextDomain.length === 0) {
        setters.setSite([]); setters.setDomainName([]); setters.setDomainId([]);
        return;
      }
      const pruned = pruneAfterFieldChange(catalog, { ...getSel(), domain: nextDomain }, 'domain');
      setters.setSite(pruned.site);
      setters.setDomainName(pruned.adUnit);
      setters.setDomainId(pruned.app);
    },
    onSiteChange: (nextSite) => {
      setters.setSite(nextSite);
      if (!cascade) return;
      if (!nextSite || nextSite.length === 0) {
        setters.setDomainName([]); setters.setDomainId([]);
        return;
      }
      const pruned = pruneAfterFieldChange(catalog, { ...getSel(), site: nextSite }, 'site');
      setters.setDomainName(pruned.adUnit);
      setters.setDomainId(pruned.app);
    },
    onAdUnitChange: (nextAdUnit) => {
      setters.setDomainName(nextAdUnit);
      if (!cascade) return;
      if (!nextAdUnit || nextAdUnit.length === 0) {
        setters.setDomainId([]);
        return;
      }
      const pruned = pruneAfterFieldChange(catalog, { ...getSel(), adUnit: nextAdUnit }, 'adUnit');
      setters.setDomainId(pruned.app);
    },
    onAppChange: (nextApp) => {
      setters.setDomainId(nextApp);
    },
  };
}
