import React from 'react';
import ChartExportButton from './ChartExportButton';

/** Keeps a grid cell so un-hiding a chart restores its original column. */
export function ChartSlot({ col = 1, wide = false, show, children }) {
  return (
    <div
      className={`chart-slot${wide ? ' wide' : ''}${show ? '' : ' is-hidden'}`}
      data-col={wide ? 'wide' : String(col)}
    >
      {show ? children : null}
    </div>
  );
}

/** Consistent chart card header with optional hint, hide, and PNG export. */
export default function ChartHeader({ title, hint, exportName, onHide, extra }) {
  const file = exportName || String(title || 'chart').replace(/&amp;/g, 'and');
  return (
    <div className="chart-header">
      <div className="chart-header-text">
        <h3 className="chart-title">{title}</h3>
        {hint ? <span className="filter-section-hint">{hint}</span> : null}
      </div>
      <div className="chart-header-actions">
        {extra}
        {onHide && (
          <button
            type="button"
            className="chart-hide-btn"
            onClick={onHide}
            title="Hide this chart"
            aria-label={`Hide ${title}`}
          >
            Hide
          </button>
        )}
        <ChartExportButton filename={file} />
      </div>
    </div>
  );
}
