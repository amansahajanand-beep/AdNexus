import React from 'react';
import { ResponsiveContainer } from 'recharts';
import { scrollableChartMinWidth } from '../../utils/chartAxis';

/**
 * Wraps a Recharts chart so long date ranges get a bottom horizontal scrollbar
 * instead of crushing every day into one viewport.
 */
export default function ScrollableChart({
  pointCount = 0,
  isNarrow = false,
  height = 280,
  children,
}) {
  const minWidth = scrollableChartMinWidth(pointCount, { isNarrow });

  if (!minWidth) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        {children}
      </ResponsiveContainer>
    );
  }

  return (
    <div className="chart-h-scroll" role="region" aria-label="Scrollable chart">
      <div className="chart-h-scroll-inner" style={{ width: minWidth, height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
