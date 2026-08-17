import React, { useEffect, useRef, useState } from 'react';
import { DASH_CHARTS } from '../../utils/dashCharts';

/** Show / hide Dashboard charts. Checked = visible. */
export default function ChartVisibilityMenu({ hiddenIds = [], onToggle, onShowAll }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const hiddenCount = hiddenIds.length;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="chart-vis-menu" ref={wrapRef}>
      <button
        type="button"
        className={`btn-reset table-tool-btn${open ? ' active' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Charts{hiddenCount ? ` (${hiddenCount} hidden)` : ''}
      </button>
      {open && (
        <div className="table-col-menu chart-vis-panel" role="menu">
          <div className="chart-vis-panel-head">
            <span>Visible charts</span>
            {hiddenCount > 0 && (
              <button type="button" className="segment-filter-clear" onClick={onShowAll}>
                Show all
              </button>
            )}
          </div>
          {DASH_CHARTS.map((chart) => (
            <label key={chart.id} className="table-col-item">
              <input
                type="checkbox"
                checked={!hiddenIds.includes(chart.id)}
                onChange={() => onToggle(chart.id)}
              />
              {chart.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
