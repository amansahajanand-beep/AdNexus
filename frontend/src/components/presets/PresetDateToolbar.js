import React from 'react';
import { isPresetAllowedForRestriction, formatDateRestrictionLabel } from '../../utils/dateRestriction';

/**
 * Date picker for Presets page — same layout as Dashboard dash-date-toolbar.
 */
export default function PresetDateToolbar({
  preset,
  startDate,
  endDate,
  presetLabel,
  presetOptions = [],
  customDatesIncomplete,
  dateFilterLocked,
  dateRestriction,
  onPreset,
  onStartDateChange,
  onEndDateChange,
  onApply,
}) {
  return (
    <div className="filter-card presets-date-card">
      <div className="dash-date-toolbar filter-card-head-sticky">
        <div className="dash-date-display">
          <span className="dash-date-label">{presetLabel}</span>
          <span className="dash-date-range">
            {customDatesIncomplete
              ? 'Select start & end dates'
              : (startDate && endDate
                ? (startDate !== endDate ? `${startDate} → ${endDate}` : startDate)
                : '…')}
          </span>
        </div>
        <div className="filter-actions filter-actions--desktop">
          <button
            type="button"
            className="btn-generate"
            onClick={onApply}
            disabled={customDatesIncomplete}
            title={customDatesIncomplete ? 'Select both start and end dates, then click Apply' : ''}
          >
            ✓ Apply dates
          </button>
        </div>
      </div>

      {dateRestriction && dateFilterLocked && (
        <p className="form-note page-restriction-note" style={{ margin: '0 0 12px' }}>
          {`Data locked to: ${formatDateRestrictionLabel(dateRestriction)}`}
        </p>
      )}

      {!dateFilterLocked && presetOptions.length > 0 && (
        <div className="preset-pills dash-preset-row">
          {presetOptions.map((p) => {
            const disabled = dateRestriction && !isPresetAllowedForRestriction(p.id, dateRestriction);
            return (
              <button
                key={p.id}
                type="button"
                className={`preset-pill ${preset === p.id ? 'active' : ''}`}
                onClick={() => onPreset(p.id)}
                disabled={disabled}
                title={disabled && dateRestriction
                  ? `Outside your allowed range (${formatDateRestrictionLabel(dateRestriction)})`
                  : ''}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      {!dateFilterLocked && preset === 'custom' && (
        <div className="filter-grid dash-custom-dates">
          <div className="filter-field">
            <label>Start Date</label>
            <input
              type="date"
              value={startDate || ''}
              min={dateRestriction?.startDate || undefined}
              max={dateRestriction?.endDate || undefined}
              onChange={(e) => onStartDateChange(e.target.value)}
            />
          </div>
          <div className="filter-field">
            <label>End Date</label>
            <input
              type="date"
              value={endDate || ''}
              min={dateRestriction?.startDate || undefined}
              max={dateRestriction?.endDate || undefined}
              onChange={(e) => onEndDateChange(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
