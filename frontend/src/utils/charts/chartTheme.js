/**
 * Soft analytics chart tokens — follow active light/dark theme CSS vars.
 */

import { isDarkTheme } from '../theme';

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

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function readThemeTokens() {
  const dark = isDarkTheme();
  return {
    gridStroke: cssVar('--chart-grid', dark ? '#243044' : '#E2E8F0'),
    axisFill: cssVar('--chart-axis', dark ? '#94A3B8' : '#64748B'),
    tipBorder: cssVar('--chart-tip-border', dark ? '#334155' : '#E2E8F0'),
    tipBg: cssVar('--chart-tip-bg', dark ? '#1A2336' : '#FFFFFF'),
    tipShadow: dark
      ? '0 8px 24px rgba(0, 0, 0, 0.4)'
      : '0 8px 24px rgba(15, 23, 42, 0.08)',
    tipColor: cssVar('--chart-tip-text', dark ? '#E8EEF7' : '#0F172A'),
  };
}

export const CHART_GRID = {
  get stroke() {
    return readThemeTokens().gridStroke;
  },
  strokeDasharray: '4 4',
};

export const CHART_AXIS_TICK = {
  fontSize: 11,
  get fill() {
    return readThemeTokens().axisFill;
  },
};

export const CHART_TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 10,
  get border() {
    return `1px solid ${readThemeTokens().tipBorder}`;
  },
  get background() {
    return readThemeTokens().tipBg;
  },
  get boxShadow() {
    return readThemeTokens().tipShadow;
  },
  get color() {
    return readThemeTokens().tipColor;
  },
};

export function softGradientStops(color, idPrefix = 'grad') {
  return {
    id: idPrefix,
    color,
    topOpacity: 0.22,
    bottomOpacity: 0.02,
  };
}
