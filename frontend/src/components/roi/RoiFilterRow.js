import React from 'react';
import { FilterIcon } from '../ui/Icon';

/**
 * Icon + label + control row for ROI filter panel.
 */
export default function RoiFilterRow({
  icon = 'accounts',
  label,
  children,
  className = '',
}) {
  return (
    <div className={`roi-filter-row ${className}`.trim()}>
      <div className="roi-filter-row-icon" aria-hidden>
        <FilterIcon name={icon} size={18} />
      </div>
      <div className="roi-filter-row-label">{label}</div>
      <div className="roi-filter-row-control">{children}</div>
    </div>
  );
}
