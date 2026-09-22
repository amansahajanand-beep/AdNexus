import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import MultiSelect from '../components/ui/MultiSelect';
import FilterChips from '../components/ui/FilterChips';
import PageHeader from '../components/ui/PageHeader';
import NetworkDashboardSection from '../components/dashboard/NetworkDashboardSection';
import { reportsAPI, clientsAPI } from '../utils/api';
import { DATE_PRESETS } from '../utils/gamReportCatalog';
import { buildFilterDropdownOptions } from '../utils/catalogOptions';
import { buildAppliedFilterChips, removeFilterChip } from '../utils/filterChips';
import { normalizeInventorySelections, isAllSelection, ALL_SENTINEL } from '../utils/inventorySelection';
import {
  EMPTY_INVENTORY_FILTERS,
  hasInventoryFilterSelection,
} from '../utils/assignedInventoryFilters';
import {
  getDateRestriction,
  clampDateRange,
  clampPresetRange,
  defaultReportRangeForUser,
  formatDateRestrictionLabel,
  allowedDatePresets,
  isPresetAllowedForRestriction,
  isFixedDateRestriction,
  isCustomRangeIncomplete,
  committedReportDates,
} from '../utils/dateRestriction';
import { usePermissions } from '../hooks/usePermissions';
import { useMedia } from '../hooks/useMedia';
import { FilterFieldIcon } from '../components/ui/Icon';

/**
 * Combined multi-network dashboard: one shared filter bar, stacked sections per GAM network.
 */
export default function MultiNetworkDashboard({ networks = [] }) {
  const { has, visibility: clientVis, user } = usePermissions();
  const canGenerate = has('canGenerateReports');
  const canFilter = clientVis?.filters !== false;
  const isNarrow = useMedia('(max-width: 768px)');

  const dateRestriction = useMemo(() => getDateRestriction(user), [user]);
  const todayInit = useMemo(() => defaultReportRangeForUser(user), [user]);
  const dateFilterLocked = Boolean(isFixedDateRestriction(dateRestriction));
  const visiblePresets = useMemo(
    () => (dateFilterLocked ? [] : allowedDatePresets(dateRestriction, DATE_PRESETS)),
    [dateRestriction, dateFilterLocked]
  );

  const [preset, setPreset] = useState('today');
  const [startDate, setStartDate] = useState(todayInit.startDate);
  const [endDate, setEndDate] = useState(todayInit.endDate);
  const [domain, setDomain] = useState([]);
  const [site, setSite] = useState([]);
  const [domainName, setDomainName] = useState([]);
  const [domainId, setDomainId] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [catalogLists, setCatalogLists] = useState({
    domainRoots: [], siteHosts: [], sitesByDomain: {}, adUnitsByHost: {}, appIds: [],
  });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [applied, setApplied] = useState({ ...todayInit, ...EMPTY_INVENTORY_FILTERS });
  const [filterApplied, setFilterApplied] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const networkIds = useMemo(() => networks.map((n) => n.id).filter(Boolean), [networks]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCatalogLoading(true);
      try {
        const res = await reportsAPI.getMergedFilterCatalog(networkIds);
        if (cancelled) return;
        if (res?.rows?.length) setCatalog(res.rows);
        setCatalogLists({
          domainRoots: res?.domainRoots || [],
          siteHosts: res?.siteHosts || [],
          sitesByDomain: res?.sitesByDomain || {},
          adUnitsByHost: res?.adUnitsByHost || {},
          appIds: (res?.appPackages || []).filter((id) => id && id !== '—'),
        });
      } catch {
        if (!cancelled) {
          setCatalog([]);
          setCatalogLists({
            domainRoots: [], siteHosts: [], sitesByDomain: {}, adUnitsByHost: {}, appIds: [],
          });
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [networkIds.join(',')]);

  const selections = useMemo(() => ({
    domain: isAllSelection(domain) ? [] : (domain || []).filter((v) => v !== ALL_SENTINEL),
    site: isAllSelection(site) ? [] : (site || []).filter((v) => v !== ALL_SENTINEL),
    adUnit: isAllSelection(domainName) ? [] : (domainName || []).filter((v) => v !== ALL_SENTINEL),
    app: isAllSelection(domainId) ? [] : (domainId || []).filter((v) => v !== ALL_SENTINEL),
  }), [domain, site, domainName, domainId]);

  const { domainOptions: domainRootOptions, siteOptions, adUnitOptions, appOptions } = useMemo(
    () => buildFilterDropdownOptions({
      catalog,
      selections,
      domainRoots: catalogLists.domainRoots,
      siteHosts: catalogLists.siteHosts,
      sitesByDomain: catalogLists.sitesByDomain,
      adUnitsByHost: catalogLists.adUnitsByHost,
      selectedDomains: isAllSelection(domain) ? [] : domain,
      independentAssignment: true,
      appIds: catalogLists.appIds,
    }),
    [catalog, selections, catalogLists, domain]
  );

  const customDatesIncomplete = isCustomRangeIncomplete(preset, startDate, endDate);

  const applyPreset = useCallback((id) => {
    if (dateFilterLocked) return;
    if (dateRestriction && !isPresetAllowedForRestriction(id, dateRestriction)) return;
    const r = clampPresetRange(id, dateRestriction);
    setPreset(id);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
  }, [dateFilterLocked, dateRestriction]);

  const applyFilter = useCallback(() => {
    if (customDatesIncomplete) return;
    const dates = clampDateRange(startDate, endDate, dateRestriction);
    const inv = normalizeInventorySelections(
      { domain, site, domainName, domainId },
      {}
    );
    setApplied({
      ...dates,
      domain: inv.domain || [],
      site: inv.site || [],
      domainName: inv.domainName || [],
      domainId: inv.domainId || [],
    });
    setFilterApplied(hasInventoryFilterSelection({
      domain: inv.domain,
      site: inv.site,
      domainName: inv.domainName,
      domainId: inv.domainId,
    }));
    setStartDate(dates.startDate);
    setEndDate(dates.endDate);
  }, [customDatesIncomplete, startDate, endDate, dateRestriction, domain, site, domainName, domainId]);

  const reset = useCallback(() => {
    const r = defaultReportRangeForUser(user);
    setPreset('today');
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setDomain([]);
    setSite([]);
    setDomainName([]);
    setDomainId([]);
    setApplied({ ...r, ...EMPTY_INVENTORY_FILTERS });
    setFilterApplied(false);
  }, [user]);

  const reportFilters = useMemo(() => {
    const dates = committedReportDates({
      preset,
      filterApplied,
      applied,
      startDate: applied?.startDate ?? startDate,
      endDate: applied?.endDate ?? endDate,
      fallback: todayInit,
    });
    if (!filterApplied || !hasInventoryFilterSelection(applied)) return dates;
    const normalized = normalizeInventorySelections(applied || {}, {});
    const { domain: d, site: s, domainName: dn, domainId: di } = normalized;
    if (!d?.length && !s?.length && !dn?.length && !di?.length) return dates;
    return { ...dates, domain: d, site: s, domainName: dn, domainId: di };
  }, [preset, filterApplied, applied, startDate, endDate, todayInit]);

  const appliedChips = useMemo(
    () => (filterApplied ? buildAppliedFilterChips(applied, {
      domainOptions: domainRootOptions,
      siteOptions,
      adUnitOptions,
      appOptions,
    }) : []),
    [filterApplied, applied, domainRootOptions, siteOptions, adUnitOptions, appOptions]
  );

  const removeChip = useCallback((chip) => {
    const draft = { domain, site, domainName, domainId };
    const { nextApplied, nextDraft } = removeFilterChip(applied, draft, chip, {
      domainOptions: domainRootOptions,
      siteOptions,
      adUnitOptions,
      appOptions,
    });
    setDomain(nextDraft.domain || []);
    setSite(nextDraft.site || []);
    setDomainName(nextDraft.domainName || []);
    setDomainId(nextDraft.domainId || []);
    setApplied((prev) => ({ ...prev, ...nextApplied }));
    setFilterApplied(hasInventoryFilterSelection(nextApplied));
  }, [applied, domain, site, domainName, domainId, domainRootOptions, siteOptions, adUnitOptions, appOptions]);

  const startConnect = async () => {
    setConnecting(true);
    try {
      const { url } = await clientsAPI.oauthUrl();
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  };

  const presetLabel = DATE_PRESETS.find((p) => p.id === preset)?.label || 'Custom';

  return (
    <div className="dashboard-page multi-network-dashboard">
      <PageHeader
        title="Dashboard"
        subtitle={`${networks.length} networks · combined view with shared filters`}
      >
        <button
          type="button"
          className="btn-reset"
          onClick={startConnect}
          disabled={connecting}
        >
          {connecting ? 'Opening Google…' : 'Connect another account'}
        </button>
        <Link to="/admin?tab=client" className="btn-reset">GAM connection</Link>
      </PageHeader>

      {dateRestriction && (
        <p className="form-note page-restriction-note">
          Allowed filter window: {formatDateRestrictionLabel(dateRestriction)}
        </p>
      )}

      <div className="filter-card dash-overview-shell">
        <div className="dash-date-toolbar filter-card-head-sticky">
          <div className="dash-date-display">
            <span className="dash-date-label">{presetLabel}</span>
            <span className="dash-date-range">
              {customDatesIncomplete
                ? 'Select start & end dates'
                : (startDate !== endDate ? `${startDate} → ${endDate}` : startDate)}
            </span>
          </div>
          <div className="filter-actions filter-actions--desktop">
            <button
              type="button"
              className="btn-generate"
              onClick={applyFilter}
              disabled={!canFilter || customDatesIncomplete}
            >
              ✓ Apply Filter
            </button>
            <button type="button" className="btn-reset" onClick={reset} disabled={!canFilter}>↺ Reset</button>
          </div>
        </div>

        {!dateFilterLocked && visiblePresets.length > 0 && (
          <div className="preset-pills dash-preset-row">
            {visiblePresets.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`preset-pill${preset === p.id ? ' active' : ''}`}
                disabled={!canFilter}
                onClick={() => applyPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {canFilter && (
          <div className="filter-grid">
            <div className="filter-field">
              <label><FilterFieldIcon name="calendar" /> Start</label>
              <input
                type="date"
                value={startDate}
                disabled={dateFilterLocked}
                onChange={(e) => { setPreset('custom'); setStartDate(e.target.value); }}
              />
            </div>
            <div className="filter-field">
              <label><FilterFieldIcon name="calendar" /> End</label>
              <input
                type="date"
                value={endDate}
                disabled={dateFilterLocked}
                onChange={(e) => { setPreset('custom'); setEndDate(e.target.value); }}
              />
            </div>
            <div className="filter-field">
              <label><FilterFieldIcon name="domain" /> Domain</label>
              <MultiSelect
                options={domainRootOptions}
                value={domain}
                onChange={setDomain}
                placeholder={catalogLoading ? 'Loading…' : 'All domains'}
                disabled={catalogLoading}
              />
            </div>
            <div className="filter-field">
              <label><FilterFieldIcon name="sites" /> Site</label>
              <MultiSelect
                options={siteOptions}
                value={site}
                onChange={setSite}
                placeholder={catalogLoading ? 'Loading…' : 'All sites'}
                disabled={catalogLoading}
              />
            </div>
            <div className="filter-field">
              <label><FilterFieldIcon name="adunit" /> Ad unit</label>
              <MultiSelect
                options={adUnitOptions}
                value={domainName}
                onChange={setDomainName}
                placeholder={catalogLoading ? 'Loading…' : 'All ad units'}
                disabled={catalogLoading}
              />
            </div>
            <div className="filter-field">
              <label><FilterFieldIcon name="apps" /> App ID</label>
              <MultiSelect
                options={appOptions}
                value={domainId}
                onChange={setDomainId}
                placeholder={catalogLoading ? 'Loading…' : 'All apps'}
                disabled={catalogLoading}
              />
            </div>
          </div>
        )}

        {appliedChips.length > 0 && (
          <FilterChips chips={appliedChips} onRemove={canFilter ? removeChip : undefined} />
        )}
        <p className="reporting-sub" style={{ marginTop: 8 }}>
          Filters combine catalogs from all linked networks
          {catalogLoading ? ' (loading…)' : ''}.
        </p>
      </div>

      {!canGenerate ? (
        <p className="form-note">Report access is disabled for your account.</p>
      ) : (
        <div className="multi-network-stack">
          {networks.map((network) => (
            <NetworkDashboardSection
              key={network.id}
              network={network}
              filters={reportFilters}
              filterApplied={filterApplied}
              visibility={clientVis}
              pageSize={isNarrow ? 12 : 50}
            />
          ))}
        </div>
      )}
    </div>
  );
}
