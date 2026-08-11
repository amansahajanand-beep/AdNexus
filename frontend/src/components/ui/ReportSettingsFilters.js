import React, { useMemo } from 'react';
import {
  REPORT_SETTINGS_OPTIONS,
  DEFAULT_REPORT_SETTINGS,
  DATE_PRESETS,
} from '../../utils/gamReportCatalog';
import {
  allowedDatePresets,
  isPresetAllowedForRestriction,
  isFixedDateRestriction,
  formatDateRestrictionLabel,
  clampDateValue,
} from '../../utils/dateRestriction';

export { DEFAULT_REPORT_SETTINGS, DATE_PRESETS };

export default function ReportSettingsFilters({
  settings = DEFAULT_REPORT_SETTINGS,
  onChange,
  preset,
  onPresetChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  disabled = false,
  dateRestriction = null,
}) {
  const set = (key, val) => onChange({ ...settings, [key]: val });
  const dateFilterLocked = isFixedDateRestriction(dateRestriction);
  const visiblePresets = useMemo(
    () => (dateFilterLocked ? [] : allowedDatePresets(dateRestriction, DATE_PRESETS)),
    [dateRestriction, dateFilterLocked]
  );

  const handlePreset = (id) => {
    if (dateFilterLocked) return;
    if (dateRestriction && !isPresetAllowedForRestriction(id, dateRestriction)) return;
    onPresetChange(id);
  };

  return (
    <div className="gam-report-settings">
      <div className="filter-section-head">
        <span className="filter-section-title">Report settings</span>
        <span className="filter-section-hint">Date, currency, timezone &amp; run type</span>
      </div>
      <div className="filter-grid">
        {!dateFilterLocked && visiblePresets.length > 0 && (
          <div className="filter-field filter-field-wide">
            <label>Date range</label>
            <div className="preset-pills">
              {visiblePresets.map((p) => {
                const presetDisabled = disabled
                  || (dateRestriction && !isPresetAllowedForRestriction(p.id, dateRestriction));
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`preset-pill ${preset === p.id ? 'active' : ''}`}
                    onClick={() => handlePreset(p.id)}
                    disabled={presetDisabled}
                    title={presetDisabled && dateRestriction
                      ? `Outside allowed range (${formatDateRestrictionLabel(dateRestriction)})`
                      : ''}
                  >{p.label}</button>
                );
              })}
            </div>
          </div>
        )}

        {!dateFilterLocked && preset === 'custom' && (
          <>
            <div className="filter-field">
              <label>Start Date</label>
              <input
                type="date"
                value={startDate || ''}
                min={dateRestriction?.startDate || undefined}
                max={dateRestriction?.endDate && endDate
                  ? (endDate < dateRestriction.endDate ? endDate : dateRestriction.endDate)
                  : (endDate || dateRestriction?.endDate || undefined)}
                disabled={disabled}
                onChange={(e) => onStartDateChange?.(clampDateValue(e.target.value, dateRestriction))}
              />
            </div>
            <div className="filter-field">
              <label>End Date</label>
              <input
                type="date"
                value={endDate || ''}
                min={dateRestriction?.startDate && startDate
                  ? (startDate > dateRestriction.startDate ? startDate : dateRestriction.startDate)
                  : (startDate || dateRestriction?.startDate || undefined)}
                max={dateRestriction?.endDate || undefined}
                disabled={disabled}
                onChange={(e) => onEndDateChange?.(clampDateValue(e.target.value, dateRestriction))}
              />
            </div>
          </>
        )}

        <div className="filter-field">
          <label>Run report as</label>
          <select
            value={settings.runType}
            disabled={disabled}
            onChange={e => set('runType', e.target.value)}
          >
            {REPORT_SETTINGS_OPTIONS.runTypes.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="filter-field">
          <label>Currency</label>
          <select
            value={settings.currency}
            disabled={disabled}
            onChange={e => set('currency', e.target.value)}
          >
            {REPORT_SETTINGS_OPTIONS.currencies.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="filter-field">
          <label>Timezone</label>
          <select
            value={settings.timezone}
            disabled={disabled}
            onChange={e => set('timezone', e.target.value)}
          >
            {REPORT_SETTINGS_OPTIONS.timezones.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="filter-field">
          <label>Ad unit view</label>
          <select
            value={settings.adUnitView}
            disabled={disabled}
            onChange={e => set('adUnitView', e.target.value)}
          >
            {REPORT_SETTINGS_OPTIONS.adUnitViews.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
