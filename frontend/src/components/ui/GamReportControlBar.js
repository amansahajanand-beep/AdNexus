import React from 'react';

/** Actionable banner shown when no dimensions/metrics are selected. */
export default function GamReportControlBar({
  showWarning = false,
  onOpenBuilder,
}) {
  if (!showWarning) return null;

  return (
    <div className="gcb-no-report-banner" role="status">
      <span className="gcb-icon" aria-hidden>○</span>
      <div className="gcb-body">
        <span className="gcb-title">Select a report to run</span>
        <span className="gcb-hint">
          Choose at least one dimension or metric in Report Builder, or pick a domain / site / ad unit / country filter, then click Apply Filter.
        </span>
      </div>
      {onOpenBuilder && (
        <button type="button" className="gcb-btn" onClick={onOpenBuilder}>
          Open Report Builder
        </button>
      )}
    </div>
  );
}
