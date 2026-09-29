import React, { useEffect, useMemo, useState } from 'react';
import { admobAPI } from '../../utils/api';
import DomainSelector from '../ui/DomainSelector';
import { getUserFacingMessage } from '../../utils/userFacingError';

const FILTER_LABELS = {
  app: 'App',
  ad_unit: 'Ad unit',
  format: 'Format',
  country: 'Country',
  platform: 'Platform',
};

export const EMPTY_ADMOB_SCOPE = {
  accountIds: [],
  apps: [],
  adUnits: [],
  filters: Object.keys(FILTER_LABELS),
};

export function admobScopeFromUser(user) {
  const s = user?.permissions?.admobScope;
  if (!s || !Array.isArray(s.accountIds)) return { ...EMPTY_ADMOB_SCOPE };
  return {
    accountIds: s.accountIds || [],
    apps: s.apps || [],
    adUnits: s.adUnits || [],
    filters: Array.isArray(s.filters) ? s.filters : EMPTY_ADMOB_SCOPE.filters,
  };
}

/**
 * Admin → user form: which AdMob publishers / apps / ad units a domain user sees (combined),
 * and which filters they may use. Publisher ids are shown to the admin only.
 */
export default function AdmobScopePanel({ value = EMPTY_ADMOB_SCOPE, onChange }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    admobAPI.scopeCatalog()
      .then((data) => { if (!cancelled) setCatalog(data); })
      .catch((err) => { if (!cancelled) setError(getUserFacingMessage(err, 'Could not load AdMob accounts.')); });
    return () => { cancelled = true; };
  }, []);

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

  const selectedAccounts = useMemo(() => new Set(value.accountIds), [value.accountIds]);
  const multiAccount = value.accountIds.length > 1;

  const appOptions = useMemo(
    () => (catalog?.apps || [])
      .filter((a) => selectedAccounts.has(a.accountId))
      .map((a) => ({
        id: a.key,
        label: multiAccount ? `${a.name} — ${accountName.get(a.accountId) || ''}` : a.name,
      })),
    [catalog, selectedAccounts, multiAccount, accountName]
  );

  const appName = useMemo(() => {
    const m = new Map();
    (catalog?.apps || []).forEach((a) => m.set(a.key, a.name));
    return m;
  }, [catalog]);

  const adUnitOptions = useMemo(
    () => (catalog?.adUnits || [])
      .filter((u) => selectedAccounts.has(u.accountId))
      .map((u) => ({
        id: u.key,
        label: u.appKey && appName.get(u.appKey) ? `${u.name} — ${appName.get(u.appKey)}` : u.name,
      })),
    [catalog, selectedAccounts, appName]
  );

  const set = (patch) => {
    const next = { ...value, ...patch };
    const allowed = new Set(next.accountIds);
    const inAccount = (k) => allowed.has(String(k).split(':')[0]);
    onChange?.({
      ...next,
      apps: next.apps.filter(inAccount),
      adUnits: next.adUnits.filter(inAccount),
    });
  };

  const toggleFilter = (dim, on) => {
    const filters = on
      ? [...new Set([...value.filters, dim])]
      : value.filters.filter((f) => f !== dim);
    set({ filters });
  };

  const loading = !catalog && !error;

  return (
    <div className="permissions-panel">
      <div className="ui-field">
        <span className="ui-field-label">AdMob — publisher accounts</span>
        <p className="form-note">
          Pick one or more AdMob publishers. If you pick several, the user sees one combined total. They never see the publisher IDs.
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        <DomainSelector
          domains={accountOptions}
          selected={value.accountIds}
          onChange={(ids) => set({ accountIds: ids })}
          loading={loading}
          selectAllLabel="Select all publishers"
          searchPlaceholder="Search publisher…"
          emptyLabel="No AdMob accounts connected"
          itemLabel="publishers"
        />
      </div>

      {value.accountIds.length > 0 && (
        <>
          <div className="ui-field">
            <span className="ui-field-label">AdMob — apps (optional)</span>
            <p className="form-note">
              Leave apps and ad units empty to give access to everything in the selected publishers.
            </p>
            <DomainSelector
              domains={appOptions}
              selected={value.apps}
              onChange={(ids) => set({ apps: ids })}
              loading={loading}
              selectAllLabel="Select all apps"
              searchPlaceholder="Search app…"
              emptyLabel="No apps synced yet for these publishers"
              itemLabel="apps"
            />
          </div>

          <div className="ui-field">
            <span className="ui-field-label">AdMob — ad units (optional)</span>
            <p className="form-note">Adds individual ad units on top of any apps picked above.</p>
            <DomainSelector
              domains={adUnitOptions}
              selected={value.adUnits}
              onChange={(ids) => set({ adUnits: ids })}
              loading={loading}
              selectAllLabel="Select all ad units"
              searchPlaceholder="Search ad unit…"
              emptyLabel="No ad units synced yet"
              itemLabel="ad units"
            />
          </div>

          <div className="ui-field perm-section">
            <span className="ui-field-label">AdMob — allowed filters &amp; breakdowns</span>
            <div className="perm-toggles">
              {Object.entries(FILTER_LABELS).map(([dim, label]) => (
                <label key={dim} className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={value.filters.includes(dim)}
                    onChange={(e) => toggleFilter(dim, e.target.checked)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <p className="form-note">Mediation details (ad sources, mediation groups) are always hidden from domain users.</p>
          </div>
        </>
      )}
    </div>
  );
}
