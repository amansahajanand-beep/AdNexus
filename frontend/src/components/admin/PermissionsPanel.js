import React, { useMemo } from 'react';
import { PERMISSION_SECTIONS } from '../../utils/permissions';
import {
  buildAdminSitePickerOptions,
  buildAdminAppPickerOptions,
} from '../../utils/catalogOptions';
import DomainSelector from '../ui/DomainSelector';
import { adminQuickDateRange } from '../../utils/dateRestriction';

const ADMIN_QUICK_DAY_LIMITS = [1, 7, 30, 90, 365];

/**
 * Grouped permission toggles for admin user assignment.
 */
export default function PermissionsPanel({
  flags,
  onFlagChange,
  allowedDomains,
  onDomainsChange,
  allowedSites = [],
  onSitesChange,
  allowedAppIds = [],
  onAppIdsChange,
  allowedAdsAccountIds = [],
  onAdsAccountsChange,
  dateRestrictionStart = '',
  dateRestrictionEnd = '',
  onDateRestrictionChange,
  domains = [],
  domainsLoading = false,
  catalogLoading = false,
  catalogRows = [],
  catalogLists = {},
  adsAccountOptions = [],
  adsAccountsLoading = false,
}) {
  const siteOptions = useMemo(
    () => buildAdminSitePickerOptions({
      catalogRows,
      siteHosts: catalogLists.siteHosts || [],
      assignedSites: allowedSites,
    }),
    [catalogRows, catalogLists, allowedSites]
  );
  const appIdOptions = useMemo(
    () => buildAdminAppPickerOptions({
      catalogRows,
      appIds: catalogLists.appIds || [],
      assignedAppIds: allowedAppIds,
    }),
    [catalogRows, catalogLists, allowedAppIds]
  );
  const pickerLoading = domainsLoading || catalogLoading;

  const renderSection = (title, items) => (
    <div className="ui-field perm-section">
      <span className="ui-field-label">{title}</span>
      <div className="perm-toggles">
        {items.map((item) => (
          <label key={item.key} className="perm-toggle" title={item.hint || ''}>
            <input
              type="checkbox"
              checked={flags[item.key] !== false}
              onChange={(e) => onFlagChange(item.key, e.target.checked)}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="permissions-panel">
      {renderSection('Page access', PERMISSION_SECTIONS.pages)}
      {renderSection('Actions', PERMISSION_SECTIONS.actions)}
      {renderSection('Metrics & reports', PERMISSION_SECTIONS.metrics)}

      <div className="ui-field">
        <span className="ui-field-label">Data scope — assigned domain names</span>
        <p className="form-note">Domain-level data access. Does not auto-assign sites — pick sites separately if needed.</p>
        <DomainSelector
          domains={domains}
          selected={allowedDomains}
          onChange={onDomainsChange}
          loading={domainsLoading}
          selectAllLabel="Select All Domains"
        />
      </div>

      <div className="ui-field">
        <span className="ui-field-label">Data scope — assigned sites (optional)</span>
        <p className="form-note">Restrict to specific site URLs. Independent of domain selection — pick any sites from the full list.</p>
        <DomainSelector
          domains={siteOptions}
          selected={allowedSites}
          onChange={onSitesChange}
          loading={pickerLoading}
          selectAllLabel="Select All Sites"
          searchPlaceholder="Search site…"
          emptyLabel="No sites found"
          itemLabel="sites"
        />
      </div>

      <div className="ui-field">
        <span className="ui-field-label">Data scope — assigned app IDs (optional)</span>
        <p className="form-note">Restrict to specific app IDs (package/bundle ids from GAM). Pick from the full network list.</p>
        <DomainSelector
          domains={appIdOptions}
          selected={allowedAppIds}
          onChange={onAppIdsChange}
          loading={pickerLoading}
          selectAllLabel="Select All App IDs"
          searchPlaceholder="Search app ID…"
          emptyLabel="No app IDs found"
          itemLabel="app IDs"
        />
      </div>

      <div className="ui-field">
        <span className="ui-field-label">Data scope — assigned Google Ads accounts</span>
        <p className="form-note">
          Pick which Ads client accounts this user can see in ROI. Leave empty for no Ads account access.
        </p>
        <DomainSelector
          domains={adsAccountOptions}
          selected={allowedAdsAccountIds}
          onChange={onAdsAccountsChange}
          loading={adsAccountsLoading}
          selectAllLabel="Select All Ads Accounts"
          searchPlaceholder="Search Ads account…"
          emptyLabel="No Ads accounts found — add them under Google Ads accounts"
          itemLabel="accounts"
        />
      </div>

      <div className="ui-field">
        <span className="ui-field-label">Allowed date range (optional)</span>
        <p className="form-note" style={{ marginBottom: 8 }}>
          User can only filter report data inside this window — from 1 day to any range you pick. Leave empty for no limit.
        </p>
        <div className="preset-pills" style={{ marginBottom: 10 }}>
          {ADMIN_QUICK_DAY_LIMITS.map((n) => (
            <button
              key={n}
              type="button"
              className="preset-pill"
              onClick={() => {
                const r = adminQuickDateRange(n);
                onDateRestrictionChange(r.start, r.end);
              }}
            >
              Last {n} day{n > 1 ? 's' : ''}
            </button>
          ))}
        </div>
        <div className="filter-date-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px' }}>
            <span className="form-note" style={{ display: 'block', marginBottom: 4 }}>From</span>
            <input
              type="date"
              className="ui-field-input"
              value={dateRestrictionStart || ''}
              max={dateRestrictionEnd || undefined}
              onChange={(e) => onDateRestrictionChange(e.target.value, dateRestrictionEnd)}
            />
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <span className="form-note" style={{ display: 'block', marginBottom: 4 }}>To</span>
            <input
              type="date"
              className="ui-field-input"
              value={dateRestrictionEnd || ''}
              min={dateRestrictionStart || undefined}
              onChange={(e) => onDateRestrictionChange(dateRestrictionStart, e.target.value)}
            />
          </div>
        </div>
        <p className="form-note">
          Or pick any custom From / To dates (no maximum).
          {(dateRestrictionStart || dateRestrictionEnd) && (
            <button
              type="button"
              className="link-action"
              style={{ marginLeft: 8 }}
              onClick={() => onDateRestrictionChange('', '')}
            >
              Clear
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
