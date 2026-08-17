import React, { useMemo, useState, useEffect } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  PieChart,
  Pie,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  suggestReportCharts,
  buildCategorySeries,
} from '../../utils/reportChartSuggest';
import { inferMetricFormat } from '../../utils/reportMetrics';
import { metricLabel, dimensionLabel } from '../../utils/gamReportCatalog';
import {
  formatAxisMetric,
  yAxisWidthForValues,
  dateAxisProps,
  chartMargins,
  truncateAxisLabel,
  scrollableChartMinWidth,
  categoryAxisWidth,
  categoryLabelMaxChars,
} from '../../utils/chartAxis';
import ScrollableChart from './ScrollableChart';
import ChartHeader from './ChartHeader';
import {
  CHART_COLORS,
  CHART_SERIES,
  CHART_GRID,
  CHART_AXIS_TICK,
  CHART_TOOLTIP_STYLE,
} from '../../utils/chartTheme';

const SHARE_COLORS = CHART_COLORS;

const COMPARE_METRICS = [
  { id: 'total_line_item_level_cpm_and_cpc_revenue', label: 'Revenue' },
  { id: 'total_line_item_level_impressions', label: 'Impressions' },
  { id: 'total_line_item_level_without_cpd_average_ecpm', label: 'eCPM' },
];

function money(v, currency = 'USD') {
  const n = Number(v) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function num(v) {
  return Number(v || 0).toLocaleString();
}

function formatMetricValue(value, format, currency) {
  if (format === 'money') return money(value, currency);
  if (format === 'percent') {
    const n = Number(value) || 0;
    const pct = n > 0 && n <= 1 ? n * 100 : n;
    return `${pct.toFixed(2)}%`;
  }
  return num(value);
}

/** Normalize radar values 0–100 so different metric scales can share one chart. */
function normalizeRadarData(data = []) {
  const max = Math.max(...data.map((d) => Number(d.value) || 0), 1);
  return data.map((d) => ({
    ...d,
    score: Math.round(((Number(d.value) || 0) / max) * 100),
  }));
}

function safeGradId(metricId) {
  return `reportAreaGrad-${String(metricId || 'm').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function cellFill(entry, idx, chart, activeSegment) {
  const base = SHARE_COLORS[idx % SHARE_COLORS.length];
  if (!activeSegment || !chart.dimensionId) return base;
  if (activeSegment.dimensionId !== chart.dimensionId) return base;
  if (String(activeSegment.value) === String(entry.name)) return base;
  return `${base}59`; // ~35% opacity hex
}

function PieLegend({ items = [] }) {
  if (!items.length) return null;
  return (
    <ul className="pie-legend pie-legend-grid" aria-label="Chart legend">
      {items.map((entry, idx) => (
        <li key={`${entry.name}-${idx}`} className="pie-legend-item" title={entry.name}>
          <span
            className="pie-legend-swatch"
            style={{ background: SHARE_COLORS[idx % SHARE_COLORS.length] }}
            aria-hidden
          />
          <span className="pie-legend-label">{entry.name}</span>
        </li>
      ))}
    </ul>
  );
}

function ChartCard({
  chart,
  currency,
  rangeLabel,
  isNarrow,
  onSegmentClick,
  activeSegment,
  compareMetricId,
  onCompareMetricChange,
}) {
  const format = chart.format || inferMetricFormat(chart.metricId);
  const metName = metricLabel(chart.metricId);
  const height = isNarrow ? 220 : 250;
  const wide = Boolean(chart.wide) || (chart.type === 'column' && chart.title?.includes('by Date'));
  const isDateSeries = chart.data?.some((d) => d.date != null)
    || /by date|trend/i.test(chart.title || '');
  const canClick = Boolean(chart.dimensionId) && Boolean(onSegmentClick) && !isDateSeries;

  if (!chart.data?.length) return null;

  const values = chart.data.map((d) => Number(d.value ?? d.primary) || 0);
  const yWidth = yAxisWidthForValues(values, format, { isNarrow });
  const n = chart.data.length;
  const dateKeys = isDateSeries
    ? chart.data.map((d) => d.date || d.name).filter(Boolean)
    : [];
  const scrollable = isDateSeries && Boolean(scrollableChartMinWidth(n, { isNarrow }));
  const xDate = isDateSeries
    ? dateAxisProps(n, { isNarrow, dates: dateKeys, scrollable })
    : null;
  const margins = chartMargins({
    isNarrow,
    hasAngledX: Boolean(xDate?.angle) || (!isDateSeries && n > 6),
    yWidth,
  });
  const chartHeight = height + (xDate?.angle ? (isNarrow ? 40 : 28) : 0);
  const gradId = safeGradId(chart.metricId);

  const emitSegment = (entry) => {
    if (!canClick || !entry) return;
    const name = entry.name;
    if (!name || name === 'Others') return;
    onSegmentClick({
      dimensionId: chart.dimensionId,
      value: name,
      chart,
    });
  };

  let body = null;
  if (chart.type === 'area') {
    body = (
      <ScrollableChart pointCount={isDateSeries ? n : 0} isNarrow={isNarrow} height={chartHeight}>
        <AreaChart data={chart.data} margin={margins}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_SERIES.primary} stopOpacity={0.22} />
              <stop offset="95%" stopColor={CHART_SERIES.primary} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
          <XAxis
            dataKey="date"
            {...(xDate || { tick: { fontSize: 11 }, tickLine: false, axisLine: false })}
          />
          <YAxis
            tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatAxisMetric(v, format, currency)}
            width={yWidth}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelFormatter={(label) => String(label || '')}
            formatter={(v) => [formatMetricValue(v, format, currency), metName]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={CHART_SERIES.primary}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            fillOpacity={1}
            dot={n <= 31}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ScrollableChart>
    );
  } else if (chart.type === 'radar') {
    const radarData = normalizeRadarData(chart.data);
    body = (
      <ResponsiveContainer width="100%" height={height}>
        <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke={CHART_GRID.stroke} />
          <PolarAngleAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_AXIS_TICK.fill }} />
          <PolarRadiusAxis angle={30} tick={false} axisLine={false} domain={[0, 100]} />
          <Radar
            name="Relative"
            dataKey="score"
            stroke={CHART_SERIES.primary}
            fill={CHART_SERIES.primary}
            fillOpacity={0.35}
          />
          <Tooltip
            formatter={(v, _n, item) => [
              formatMetricValue(item?.payload?.value, inferMetricFormat(item?.payload?.metricId), currency),
              item?.payload?.name || 'Metric',
            ]}
          />
        </RadarChart>
      </ResponsiveContainer>
    );
  } else if (chart.type === 'line') {
    body = (
      <ScrollableChart pointCount={isDateSeries ? n : 0} isNarrow={isNarrow} height={chartHeight}>
        <LineChart data={chart.data} margin={margins}>
          <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
          <XAxis
            dataKey={isDateSeries ? 'date' : 'name'}
            {...(xDate || { tick: { fontSize: 11 }, tickLine: false, axisLine: false })}
          />
          <YAxis
            tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatAxisMetric(v, format, currency)}
            width={yWidth}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelFormatter={(label) => String(label || '')}
            formatter={(v) => [formatMetricValue(v, format, currency), metName]}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={CHART_SERIES.accent}
            strokeWidth={2}
            dot={n <= 31}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ScrollableChart>
    );
  } else if (chart.type === 'composed') {
    const formatB = chart.formatB || inferMetricFormat(chart.metricIdB);
    const metB = metricLabel(chart.metricIdB);
    const yWidthB = yAxisWidthForValues(
      chart.data.map((d) => Number(d.secondary) || 0),
      formatB,
      { isNarrow }
    );
    const composedMargins = chartMargins({
      isNarrow,
      hasAngledX: Boolean(xDate?.angle),
      yWidth,
      rightWidth: yWidthB,
    });
    body = (
      <ScrollableChart pointCount={n} isNarrow={isNarrow} height={chartHeight}>
        <ComposedChart data={chart.data} margin={composedMargins}>
          <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
          <XAxis dataKey="date" {...(xDate || { tick: { fontSize: 11 }, tickLine: false, axisLine: false })} />
          <YAxis
            yAxisId="left"
            tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatAxisMetric(v, format, currency)}
            width={yWidth}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ ...CHART_AXIS_TICK, fontSize: isNarrow ? 10 : 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatAxisMetric(v, formatB, currency)}
            width={yWidthB}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelFormatter={(label) => String(label || '')}
            formatter={(v, name) => {
              const fmt = name === metB ? formatB : format;
              return [formatMetricValue(v, fmt, currency), name];
            }}
          />
          <Legend />
          <Bar
            yAxisId="left"
            dataKey="primary"
            name={metName}
            fill={CHART_SERIES.primary}
            radius={[4, 4, 0, 0]}
            maxBarSize={isNarrow ? 14 : 28}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="secondary"
            name={metB}
            stroke={CHART_SERIES.accent}
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ScrollableChart>
    );
  } else if (chart.type === 'pie') {
    body = (
      <div className="pie-chart-block">
        <ResponsiveContainer width="100%" height={isNarrow ? 168 : 180}>
          <PieChart className="chart-pie-no-focus" margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Pie
              data={chart.data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={isNarrow ? 42 : 50}
              outerRadius={isNarrow ? 68 : 76}
              paddingAngle={2}
              isAnimationActive={false}
              stroke="none"
              cursor={canClick ? 'pointer' : undefined}
              onClick={(data) => emitSegment(data)}
            >
              {chart.data.map((entry, idx) => (
                <Cell
                  key={`${entry.name}-${idx}`}
                  fill={cellFill(entry, idx, chart, activeSegment)}
                  stroke="none"
                  style={{ outline: 'none' }}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(v, name) => [formatMetricValue(v, format, currency), name || metName]}
            />
          </PieChart>
        </ResponsiveContainer>
        <PieLegend items={chart.data} />
      </div>
    );
  } else if (chart.type === 'column') {
    const angledCats = !isDateSeries && n > 6;
    const colMargins = chartMargins({
      isNarrow,
      hasAngledX: Boolean(xDate?.angle) || angledCats,
      yWidth,
    });
    const chartH = height + ((xDate?.angle || angledCats) ? (isNarrow ? 40 : 32) : 0);
    body = (
      <ScrollableChart pointCount={isDateSeries ? n : 0} isNarrow={isNarrow} height={chartH}>
        <BarChart
          data={chart.data}
          margin={colMargins}
          barCategoryGap={isNarrow ? '18%' : '12%'}
          barGap={isNarrow ? 3 : 2}
        >
          <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
          <XAxis
            dataKey={isDateSeries ? 'date' : 'name'}
            {...(xDate || {
              tick: { fontSize: isNarrow ? 9 : 11 },
              axisLine: false,
              tickLine: false,
              interval: n > 10 ? Math.ceil(n / (isNarrow ? 4 : 7)) - 1 : 0,
              angle: angledCats ? -35 : 0,
              textAnchor: angledCats ? 'end' : 'middle',
              height: angledCats ? 56 : 30,
              tickFormatter: (v) => truncateAxisLabel(v, isNarrow ? 10 : 14),
            })}
          />
          <YAxis
            tick={{ fontSize: 11, fill: CHART_AXIS_TICK.fill }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => formatAxisMetric(v, format, currency)}
            width={yWidth}
          />
          <Tooltip
            formatter={(v, _n, item) => [
              formatMetricValue(v, format, currency),
              item?.payload?.name || metName,
            ]}
            labelFormatter={(label) => String(label || '')}
          />
          <Bar
            dataKey="value"
            radius={[6, 6, 0, 0]}
            maxBarSize={isNarrow ? 28 : 48}
            cursor={canClick ? 'pointer' : undefined}
            onClick={(data) => emitSegment(data?.payload || data)}
          >
            {chart.data.map((entry, idx) => (
              <Cell
                key={`${entry.name || entry.date}-${idx}`}
                fill={cellFill(entry, idx, chart, activeSegment)}
              />
            ))}
          </Bar>
        </BarChart>
      </ScrollableChart>
    );
  } else {
    const labelW = categoryAxisWidth({ isNarrow });
    const labelMax = categoryLabelMaxChars({ isNarrow });
    body = (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={chart.data}
          layout="vertical"
          margin={{ top: 8, right: 12, left: isNarrow ? 4 : 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray={CHART_GRID.strokeDasharray} stroke={CHART_GRID.stroke} />
          <XAxis
            type="number"
            tick={{ fontSize: 11 }}
            axisLine={false}
            tickFormatter={(v) => formatAxisMetric(v, format, currency)}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={labelW}
            tick={{ fontSize: isNarrow ? 10 : 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => truncateAxisLabel(v, labelMax)}
          />
          <Tooltip
            formatter={(v, _n, item) => [
              formatMetricValue(v, format, currency),
              item?.payload?.name || metName,
            ]}
          />
          <Bar
            dataKey="value"
            radius={[0, 6, 6, 0]}
            cursor={canClick ? 'pointer' : undefined}
            onClick={(data) => emitSegment(data?.payload || data)}
          >
            {chart.data.map((entry, idx) => (
              <Cell
                key={`${entry.name}-${idx}`}
                fill={cellFill(entry, idx, chart, activeSegment)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <div className={`chart-card${wide ? ' wide' : ''}`}>
      <ChartHeader title={chart.title} hint={chart.hint} exportName={chart.title} />
      {chart.compareEnabled && onCompareMetricChange && (
        <div className="chart-metric-toggle" role="group" aria-label="Compare metric">
          {COMPARE_METRICS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`chart-metric-toggle-btn${(compareMetricId || chart.metricId) === opt.id ? ' active' : ''}`}
              onClick={() => onCompareMetricChange(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {canClick && (
        <p className="chart-click-hint">Click a segment to filter the table below</p>
      )}
      {rangeLabel ? <span className="report-range" style={{ display: 'block', marginBottom: 8 }}>{rangeLabel}</span> : null}
      {body}
    </div>
  );
}

/**
 * Auto-pick several varied charts (column / bar / area / radar) from applied fields.
 * Pass `trend` (server SQL daily series) so date charts cover the full selected range
 * even when table `rows` are capped to the newest grain slice.
 */
export default function ReportAutoCharts({
  rows = [],
  trend = [],
  dimensions = [],
  metrics = [],
  visibility = {},
  currency = 'USD',
  startDate,
  endDate,
  mode = 'inventory',
  isNarrow = false,
  onSegmentClick,
  activeSegment = null,
}) {
  const [compareMetricId, setCompareMetricId] = useState(null);

  useEffect(() => {
    setCompareMetricId(null);
  }, [dimensions, metrics, mode, startDate, endDate]);

  const charts = useMemo(() => {
    let list = suggestReportCharts({
      dimensions,
      metrics,
      rows,
      trend,
      visibility,
      mode,
    }).filter((c) => Array.isArray(c?.data) && c.data.some((d) => (
      Number(d?.value) > 0
      || Number(d?.score) > 0
      || Number(d?.primary) > 0
      || Number(d?.secondary) > 0
    )));

    const catIdx = list.findIndex((c) => c.compareEnabled && c.dimensionId);
    if (catIdx >= 0 && compareMetricId) {
      const base = list[catIdx];
      const data = buildCategorySeries(rows, base.dimensionId, compareMetricId, { topN: 10 });
      if (data.length) {
        list = list.slice();
        list[catIdx] = {
          ...base,
          metricId: compareMetricId,
          format: inferMetricFormat(compareMetricId),
          title: `${metricLabel(compareMetricId)} by ${dimensionLabel(base.dimensionId)}`,
          hint: `${base.type === 'column' ? 'Column' : 'Bar'} · by ${dimensionLabel(base.dimensionId)} · ${metricLabel(compareMetricId)}`,
          data,
          compareEnabled: true,
        };
      }
    }

    return list;
  }, [dimensions, metrics, rows, trend, visibility, mode, compareMetricId]);

  if (!charts.length) return null;

  const rangeLabel = startDate && endDate ? `${startDate} → ${endDate}` : '';

  return (
    <div className="charts-grid report-auto-charts" style={{ marginTop: 16 }}>
      {charts.map((chart) => (
        <ChartCard
          key={`${chart.type}-${chart.metricId}-${chart.title}-${chart.dimensionId || ''}`}
          chart={chart}
          currency={currency}
          rangeLabel={rangeLabel}
          isNarrow={isNarrow}
          onSegmentClick={onSegmentClick}
          activeSegment={activeSegment}
          compareMetricId={compareMetricId}
          onCompareMetricChange={chart.compareEnabled ? setCompareMetricId : undefined}
        />
      ))}
    </div>
  );
}
