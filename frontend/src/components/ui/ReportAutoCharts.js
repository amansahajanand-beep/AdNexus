import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  BarChart,
  Bar,
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
} from 'recharts';
import { suggestReportCharts } from '../../utils/reportChartSuggest';
import { inferMetricFormat } from '../../utils/reportMetrics';
import { metricLabel } from '../../utils/gamReportCatalog';

const SHARE_COLORS = ['#1a73e8', '#34a853', '#f29900', '#ea4335', '#8e24aa', '#00acc1'];

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

function ChartCard({ chart, currency, rangeLabel, isNarrow }) {
  const format = chart.format || inferMetricFormat(chart.metricId);
  const metName = metricLabel(chart.metricId);
  const height = isNarrow ? 220 : 250;
  const wide = Boolean(chart.wide) || chart.type === 'column' && chart.title?.includes('by Date');

  // No empty placeholder cards — only render charts that have data.
  if (!chart.data?.length) return null;

  let body = null;
  if (chart.type === 'area') {
    body = (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={chart.data} margin={{ top: 10, right: isNarrow ? 8 : 20, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id={`reportAreaGrad-${chart.metricId}-${chart.title}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#1a73e8" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#1a73e8" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: isNarrow ? 10 : 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatMetricValue(v, format, currency)}
            width={isNarrow ? 52 : 72}
          />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '0.5px solid #e0e0e0' }}
            formatter={(v) => [formatMetricValue(v, format, currency), metName]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#1a73e8"
            strokeWidth={2}
            fill={`url(#reportAreaGrad-${chart.metricId}-${chart.title})`}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line type="monotone" dataKey="value" stroke="#1a73e8" strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    );
  } else if (chart.type === 'radar') {
    const radarData = normalizeRadarData(chart.data);
    body = (
      <ResponsiveContainer width="100%" height={height}>
        <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke="#e8eaed" />
          <PolarAngleAxis dataKey="name" tick={{ fontSize: 10, fill: '#5f6368' }} />
          <PolarRadiusAxis angle={30} tick={false} axisLine={false} domain={[0, 100]} />
          <Radar
            name="Relative"
            dataKey="score"
            stroke="#1a73e8"
            fill="#1a73e8"
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
  } else if (chart.type === 'column') {
    body = (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chart.data} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={0}
            angle={chart.data.length > 6 ? -25 : 0}
            textAnchor={chart.data.length > 6 ? 'end' : 'middle'}
            height={chart.data.length > 6 ? 56 : 30}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => formatMetricValue(v, format, currency)}
            width={isNarrow ? 48 : 64}
          />
          <Tooltip
            formatter={(v, _n, item) => [
              formatMetricValue(v, format, currency),
              item?.payload?.name || metName,
            ]}
          />
          <Bar dataKey="value" radius={[6, 6, 0, 0]}>
            {chart.data.map((entry, idx) => (
              <Cell key={`${entry.name}-${idx}`} fill={SHARE_COLORS[idx % SHARE_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  } else {
    // Default: horizontal bar
    body = (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={chart.data}
          layout="vertical"
          margin={{ top: 8, right: 12, left: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis type="number" tick={{ fontSize: 11 }} axisLine={false} tickFormatter={(v) => formatMetricValue(v, format, currency)} />
          <YAxis
            type="category"
            dataKey="name"
            width={isNarrow ? 72 : 100}
            tick={{ fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            formatter={(v, _n, item) => [
              formatMetricValue(v, format, currency),
              item?.payload?.name || metName,
            ]}
          />
          <Bar dataKey="value" radius={[0, 6, 6, 0]}>
            {chart.data.map((entry, idx) => (
              <Cell key={`${entry.name}-${idx}`} fill={SHARE_COLORS[idx % SHARE_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <div className={`chart-card${wide ? ' wide' : ''}`}>
      <div className="chart-header">
        <h3 className="chart-title">{chart.title}</h3>
        <span className="filter-section-hint">{chart.hint}</span>
      </div>
      {rangeLabel ? <span className="report-range" style={{ display: 'block', marginBottom: 8 }}>{rangeLabel}</span> : null}
      {body}
    </div>
  );
}

/**
 * Auto-pick several varied charts (column / bar / area / radar) from applied fields.
 */
export default function ReportAutoCharts({
  rows = [],
  dimensions = [],
  metrics = [],
  visibility = {},
  currency = 'USD',
  startDate,
  endDate,
  mode = 'inventory',
  isNarrow = false,
}) {
  const charts = useMemo(
    () => suggestReportCharts({
      dimensions,
      metrics,
      rows,
      visibility,
      mode,
    }).filter((c) => Array.isArray(c?.data) && c.data.some((d) => Number(d?.value) > 0 || Number(d?.score) > 0)),
    [dimensions, metrics, rows, visibility, mode]
  );

  // Hide the whole charts block when this query has nothing to plot.
  if (!charts.length) return null;

  const rangeLabel = startDate && endDate ? `${startDate} → ${endDate}` : '';

  return (
    <div className="charts-grid report-auto-charts" style={{ marginTop: 16 }}>
      {charts.map((chart) => (
        <ChartCard
          key={`${chart.type}-${chart.metricId}-${chart.title}`}
          chart={chart}
          currency={currency}
          rangeLabel={rangeLabel}
          isNarrow={isNarrow}
        />
      ))}
    </div>
  );
}
