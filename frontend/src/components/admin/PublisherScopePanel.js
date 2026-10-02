import React, { useEffect, useMemo, useState } from 'react';
import { admobAPI, adsenseAPI } from '../../utils/api';
import DomainSelector from '../ui/DomainSelector';
import { getUserFacingMessage } from '../../utils/userFacingError';

/** Metric groups and report areas a publisher scope can switch on or off. Same groups as the general toggles. */
export const SCOPE_METRICS = ['revenue', 'impressions', 'ctr', 'ecpm'];
export const SCOPE_REPORTS = ['dashboard', 'reporting', 'download'];

const REPORT_LABELS = { dashboard: 'Dashboard', reporting: 'Reporting', download: 'Download CSV' };

const PRODUCTS = {
  admob: {
    name: 'AdMob',
    api: admobAPI,
    accountsLabel: 'AdMob — publisher accounts',
    accountsNote: 'Pick one or more AdMob publishers. If you pick several, the user sees one combined total. They never see the publisher IDs.',
    emptyAccounts: 'No AdMob accounts connected',
    items: { key: 'apps', noun: 'apps', title: 'AdMob — apps (optional)', select: 'Select all apps', search: 'Search app…', empty: 'No apps synced yet for these publishers' },
    units: { key: 'adUnits', title: 'AdMob — ad units (optional)', note: 'Adds individual ad units on top of any apps picked above.' },
    scopeNote: 'Leave apps and ad units empty to give access to everything in the selected publishers.',
    filters: { app: 'App', ad_unit: 'Ad unit', format: 'Format', country: 'Country', platform: 'Platform' },
    filtersNote: 'Mediation details (ad sources, mediation groups) are always hidden from domain users.',
    metricLabels: { revenue: 'Revenue & earnings', impressions: 'Impressions', ctr: 'CTR & clicks', ecpm: 'eCPM & match rate' },
  },
  adsense: {
    name: 'AdSense',
    api: adsenseAPI,
    accountsLabel: 'AdSense — publisher accounts',
    accountsNote: 'Pick one or more AdSense publishers. If you pick several, the user sees one combined total. They never see the publisher IDs.',
    emptyAccounts: 'No AdSense accounts connected',
    items: { key: 'sites', noun: 'sites', title: 'AdSense — sites (optional)', select: 'Select all sites', search: 'Search site…', empty: 'No sites synced yet for these publishers. Run a sync first.' },
    units: null,
    scopeNote: 'Leave sites empty to give access to everything in the selected publishers.',
    filters: { site: 'Site', country: 'Country', platform: 'Platform' },
    filtersNote: 'Ad units are not offered: AdSense attributes only part of the earnings to ad units, so a limited view would show wrong totals.',
    metricLabels: { revenue: 'Revenue & earnings', impressions: 'Page views & impressions', ctr: 'CTR & clicks', ecpm: 'RPM' },
  },
};

function emptyScope(product) {
  const cfg = PRODUCTS[product];
  return {
    accountIds: [],
    [cfg.items.key]: [],
    ...(cfg.units ? { [cfg.units.key]: [] } : {}),
    filters: Object.keys(cfg.filters),
    metrics: [...SCOPE_METRICS],
    reports: [...SCOPE_REPORTS],
  };
}

export const EMPTY_ADMOB_SCOPE = emptyScope('admob');
export const EMPTY_ADSENSE_SCOPE = emptyScope('adsense');

/** Users saved before per-product metrics existed keep what their general "Metrics & reports" flags allowed. */
function metricsFromFlags(p = {}) {
  return [
    p.canSeeRevenue !== false && 'revenue',
    p.canSeeImpressions !== false && 'impressions',
    p.canSeeCTR !== false && 'ctr',
    p.canSeeECPM !== false && 'ecpm',
  ].filter(Boolean);
}

function reportsFromFlags(p = {}) {
  return ['dashboard', 'reporting', ...(p.canDownloadReports !== false ? ['download'] : [])];
}

export function scopeFromUser(user, product) {
  const cfg = PRODUCTS[product];
  const perms = user?.permissions || {};
  const s = perms[`${product}Scope`];
  if (!s || !Array.isArray(s.accountIds)) return emptyScope(product);
  return {
    accountIds: s.accountIds || [],
    [cfg.items.key]: s[cfg.items.key] || [],
    ...(cfg.units ? { [cfg.units.key]: s[cfg.units.key] || [] } : {}),
    filters: Array.isArray(s.filters) ? s.filters : Object.keys(cfg.filters),
    metrics: Array.isArray(s.metrics) ? s.metrics : metricsFromFlags(perms),
    reports: Array.isArray(s.reports) ? s.reports : reportsFromFlags(perms),
  };
}

export const admobScopeFromUser = (user) => scopeFromUser(user, 'admob');
export const adsenseScopeFromUser = (user) => scopeFromUser(user, 'adsense');

function ToggleGroup({ title, note, options, selected, onToggle }) {
  return (
    <div className="ui-field perm-section">
      <span className="ui-field-label">{title}</span>
      <div className="perm-toggles">
        {options.map(([key, label]) => (
          <label key={key} className="perm-toggle">
            <input type="checkbox" checked={selected.includes(key)} onChange={(e) => onToggle(key, e.target.checked)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {note ? <p className="form-note">{note}</p> : null}
    </div>
  );
}

/**
 * Admin → user form: which publishers / items a domain user sees (combined), which filters they may use,
 * and which metrics and report areas are open to them for this product. Publisher ids are shown to the admin only.
 */
export default function PublisherScopePanel({ product, value, onChange }) {
  const cfg = PRODUCTS[product];
  const scope = value || emptyScope(product);
  const itemKey = cfg.items.key;
  const unitKey = cfg.units?.key;
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    cfg.api.scopeCatalog()
      .then((data) => { if (!cancelled) setCatalog(data); })
      .catch((err) => { if (!cancelled) setError(getUserFacingMessage(err, `Could not load ${cfg.name} accounts.`)); });
    return () => { cancelled = true; };
  }, [cfg]);

  const accountName = useMemo(() => {
    const m = new Map();
    (catalog?.accounts || []).forEach((a) => m.set(a.id, a.name || a.publisherId));
    return m;
  }, [catalog]);

  const accountOptions = useMemo(
    () => (catalog?.accounts || []).map((a) => ({
      id: a.id,
      label: a.name && a.name !== a.publisherId ? `${a.name} (${a.publisherId})` : a.publisherId,
    })),
    [catalog]
  );

  const selectedAccounts = useMemo(() => new Set(scope.accountIds), [scope.accountIds]);
  const multiAccount = scope.accountIds.length > 1;

  const itemOptions = useMemo(
    () => (catalog?.[itemKey] || [])
      .filter((a) => selectedAccounts.has(a.accountId))
      .map((a) => ({
        id: a.key,
        label: multiAccount ? `${a.name} — ${accountName.get(a.accountId) || ''}` : a.name,
      })),
    [catalog, itemKey, selectedAccounts, multiAccount, accountName]
  );

  const itemName = useMemo(() => {
    const m = new Map();
    (catalog?.[itemKey] || []).forEach((a) => m.set(a.key, a.name));
    return m;
  }, [catalog, itemKey]);

  const unitOptions = useMemo(
    () => (unitKey ? (catalog?.[unitKey] || []) : [])
      .filter((u) => selectedAccounts.has(u.accountId))
      .map((u) => ({
        id: u.key,
        label: u.appKey && itemName.get(u.appKey) ? `${u.name} — ${itemName.get(u.appKey)}` : u.name,
      })),
    [catalog, unitKey, selectedAccounts, itemName]
  );

  const set = (patch) => {
    const next = { ...scope, ...patch };
    const allowed = new Set(next.accountIds);
    const inAccount = (k) => allowed.has(String(k).split(':')[0]);
    const out = { ...next, [itemKey]: (next[itemKey] || []).filter(inAccount) };
    if (unitKey) out[unitKey] = (next[unitKey] || []).filter(inAccount);
    onChange?.(out);
  };

  const toggleIn = (field, all) => (key, on) => {
    const current = scope[field] || all;
    set({ [field]: on ? [...new Set([...current, key])] : current.filter((v) => v !== key) });
  };

  const loading = !catalog && !error;

  return (
    <div className="permissions-panel">
      <div className="ui-field">
        <span className="ui-field-label">{cfg.accountsLabel}</span>
        <p className="form-note">{cfg.accountsNote}</p>
        {error ? <p className="form-error">{error}</p> : null}
        <DomainSelector
          domains={accountOptions}
          selected={scope.accountIds}
          onChange={(ids) => set({ accountIds: ids })}
          loading={loading}
          selectAllLabel="Select all publishers"
          searchPlaceholder="Search publisher…"
          emptyLabel={cfg.emptyAccounts}
          itemLabel="publishers"
        />
      </div>

      {scope.accountIds.length > 0 && (
        <>
          <div className="ui-field">
            <span className="ui-field-label">{cfg.items.title}</span>
            <p className="form-note">{cfg.scopeNote}</p>
            <DomainSelector
              domains={itemOptions}
              selected={scope[itemKey] || []}
              onChange={(ids) => set({ [itemKey]: ids })}
              loading={loading}
              selectAllLabel={cfg.items.select}
              searchPlaceholder={cfg.items.search}
              emptyLabel={cfg.items.empty}
              itemLabel={cfg.items.noun}
            />
          </div>

          {cfg.units ? (
            <div className="ui-field">
              <span className="ui-field-label">{cfg.units.title}</span>
              <p className="form-note">{cfg.units.note}</p>
              <DomainSelector
                domains={unitOptions}
                selected={scope[unitKey] || []}
                onChange={(ids) => set({ [unitKey]: ids })}
                loading={loading}
                selectAllLabel="Select all ad units"
                searchPlaceholder="Search ad unit…"
                emptyLabel="No ad units synced yet"
                itemLabel="ad units"
              />
            </div>
          ) : null}

          <ToggleGroup
            title={`${cfg.name} — allowed filters & breakdowns`}
            note={cfg.filtersNote}
            options={Object.entries(cfg.filters)}
            selected={scope.filters || []}
            onToggle={toggleIn('filters', Object.keys(cfg.filters))}
          />

          <ToggleGroup
            title={`${cfg.name} — metrics`}
            options={SCOPE_METRICS.map((m) => [m, cfg.metricLabels[m]])}
            selected={scope.metrics || SCOPE_METRICS}
            onToggle={toggleIn('metrics', SCOPE_METRICS)}
          />

          <ToggleGroup
            title={`${cfg.name} — reports`}
            note="Which pages the user can open and whether they can export tables."
            options={SCOPE_REPORTS.map((r) => [r, REPORT_LABELS[r]])}
            selected={scope.reports || SCOPE_REPORTS}
            onToggle={toggleIn('reports', SCOPE_REPORTS)}
          />
        </>
      )}
    </div>
  );
}
