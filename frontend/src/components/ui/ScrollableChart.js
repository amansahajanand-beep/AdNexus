import React, { useLayoutEffect, useRef, useState } from 'react';
import { ResponsiveContainer } from 'recharts';
import { scrollableChartMinWidth } from '../../utils/chartAxis';

/**
 * Wide screens: chart always fills the card.
 * Small screens: long series get a horizontal scrollbar instead of crushed points.
 */
export default function ScrollableChart({
  pointCount = 0,
  isNarrow = false,
  height = 280,
  children,
}) {
  const wrapRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const desired = scrollableChartMinWidth(pointCount, { isNarrow }) || 0;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const update = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setContainerWidth(w);
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const needsScroll = desired > 0 && containerWidth > 0 && desired > containerWidth + 8;
  const chartPx = needsScroll ? desired : undefined;

  return (
    <div
      ref={wrapRef}
      className={needsScroll ? 'chart-h-scroll' : 'chart-fill'}
      role={needsScroll ? 'region' : undefined}
      aria-label={needsScroll ? 'Scrollable chart' : undefined}
    >
      {needsScroll ? (
        <div className="chart-h-scroll-inner" style={{ width: chartPx, minWidth: chartPx, height }}>
          <ResponsiveContainer width={chartPx} height={height}>
            {children}
          </ResponsiveContainer>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {children}
        </ResponsiveContainer>
      )}
    </div>
  );
}
