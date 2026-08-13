/**
 * Soft Stripe/Mixpanel-style chart tokens shared by Dashboard + Reporting.
 */

export const CHART_COLORS = [
  '#2563EB',
  '#0D9488',
  '#F59E0B',
  '#EF4444',
  '#6366F1',
  '#14B8A6',
  '#64748B',
  '#84CC16',
];

export const CHART_SERIES = {
  primary: '#2563EB',
  secondary: '#0D9488',
  accent: '#F59E0B',
  danger: '#EF4444',
  muted: '#94A3B8',
};

export const CHART_GRID = {
  stroke: '#E8EEF5',
  strokeDasharray: '4 4',
};

export const CHART_AXIS_TICK = {
  fontSize: 11,
  fill: '#64748B',
};

export const CHART_TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 10,
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)',
  color: '#0F172A',
};

export function softGradientStops(color, idPrefix = 'grad') {
  return {
    id: idPrefix,
    color,
    topOpacity: 0.22,
    bottomOpacity: 0.02,
  };
}
