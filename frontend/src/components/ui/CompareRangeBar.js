import React from 'react';
import { COMPARE_MODES } from '../../utils/periodCompare';

/** Compact compare-range picker: prior period, last week, last month, or custom dates. */
export default function CompareRangeBar({
  mode = 'prior',
  onModeChange,
  customStart = '',
  customEnd = '',
  onCustomStart,
  onCustomEnd,
  minDate,
  maxDate,
  disabled = false,
}) {
  return (
    <div className="compare-bar">
      <span className="compare-bar-label">Compare</span>
      <div className="preset-pills compare-bar-pills" role="group" aria-label="Compare range">
        {COMPARE_MODES.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`preset-pill${mode === opt.id ? ' active' : ''}`}
            disabled={disabled}
            onClick={() => onModeChange(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {mode === 'custom' && (
        <div className="compare-bar-custom">
          <label className="compare-bar-date">
            <span>From</span>
            <input
              type="date"
              value={customStart}
              min={minDate}
              max={customEnd || maxDate}
              disabled={disabled}
              onChange={(e) => onCustomStart(e.target.value)}
            />
          </label>
          <label className="compare-bar-date">
            <span>To</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || minDate}
              max={maxDate}
              disabled={disabled}
              onChange={(e) => onCustomEnd(e.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}
