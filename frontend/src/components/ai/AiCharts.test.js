/* AI charts: trend line, comparison, ranked bars, share ring, breakdown tabs. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import AiCharts, { formatValue } from './AiCharts';

global.IS_REACT_ACT_ENVIRONMENT = true;

const CHARTS = {
  trend: {
    label: 'Estimated earnings',
    kind: 'money',
    points: [{ date: '2026-09-24', v: 100 }, { date: '2026-09-25', v: 150 }, { date: '2026-09-26', v: 90 }, { date: '2026-09-27', v: 400 }],
    anomalies: ['2026-09-27'],
  },
  compare: [{ label: 'Revenue', kind: 'money', now: 1200, prev: 1000 }, { label: 'Impressions', kind: 'count', now: 5000, prev: 8000 }],
  breakdowns: [
    { by: 'Site', kind: 'money', totalValue: 1000, items: [{ name: 'a.example.com', value: 600, share: 60, change: 12.5 }, { name: 'b.example.com', value: 300, share: 30, change: -40 }] },
    { by: 'Site (ROI, by spend)', kind: 'percent', items: [{ name: 'a.example.com', value: 80, extra: 'Spend $10' }, { name: 'c.example.com', value: -30 }] },
  ],
};

let container;
let root;
async function mount(props) {
  root = createRoot(container);
  await act(async () => { root.render(<AiCharts {...props} />); });
}
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  container.remove();
});

test('formats values by kind', () => {
  expect(formatValue('money', 1234.5, 'USD')).toBe('$1,234.50');
  expect(formatValue('money', 1500000, 'USD', { compact: true })).toBe('$1.5M');
  expect(formatValue('percent', -30.04)).toBe('-30.0%');
  expect(formatValue('count', 12500)).toBe('12.5K');
  expect(formatValue('money', null)).toBe('—');
});

test('draws the trend with an unusual-day marker, the comparison and the ranked bars with a share ring', async () => {
  await mount({ charts: CHARTS, currency: 'USD' });
  expect(container.querySelector('.aic-trend .aic-line')).not.toBeNull();
  expect(container.querySelectorAll('.aic-odd')).toHaveLength(1);
  expect(container.querySelector('.aic-plot svg').getAttribute('aria-label')).toContain('highest $400.00 on 09-27');
  expect(container.textContent).toContain('Against the prior period');
  expect(container.textContent).toContain('Impressions');
  expect(container.querySelectorAll('.aic-cmp-bar')).toHaveLength(4);
  expect(container.querySelectorAll('.aic-bars li')).toHaveLength(2);
  expect(container.querySelector('.aic-compare .aic-chg.down').textContent).toContain('37.5%');
  expect([...container.querySelectorAll('.aic-bars .aic-chg')].map((c) => c.textContent.trim())).toEqual(['12.5%', '40.0%']);
  expect(container.querySelector('.aic-ring')).not.toBeNull();
});

test('tabs switch the breakdown; ROI lists diverge from zero and have no share ring', async () => {
  await mount({ charts: CHARTS });
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  expect(tabs.map((t) => t.textContent)).toEqual(['Site', 'Site (ROI, by spend)']);
  await act(async () => { tabs[1].click(); });
  expect(container.querySelector('.aic-bars.is-diverging')).not.toBeNull();
  expect(container.querySelector('.aic-bar-fill.d-l')).not.toBeNull();
  expect(container.querySelector('.aic-bar-fill.d-r')).not.toBeNull();
  expect(container.querySelector('.aic-ring')).toBeNull();
});

test('shows only what exists, and nothing for missing or empty data', async () => {
  await mount({ charts: { trend: null, compare: [], breakdowns: [CHARTS.breakdowns[0]] } });
  expect(container.querySelector('.aic-trend')).toBeNull();
  expect(container.querySelector('[role="tab"]')).toBeNull();
  expect(container.querySelectorAll('.aic-bars li')).toHaveLength(2);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => { root.render(<AiCharts charts={{ trend: { label: 'x', kind: 'money', points: [{ date: 'a', v: 1 }], anomalies: [] }, compare: [], breakdowns: [] }} />); });
  expect(container.innerHTML).toBe('');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => { root.render(<AiCharts charts={null} />); });
  expect(container.innerHTML).toBe('');
});

test('hovering the trend shows the value for the nearest day', async () => {
  await mount({ charts: { ...CHARTS, compare: [] }, currency: 'USD' });
  const plot = container.querySelector('.aic-plot');
  plot.getBoundingClientRect = () => ({ left: 0, width: 640, top: 0, height: 190 });
  await act(async () => {
    plot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 640 }));
  });
  expect(container.querySelector('.aic-tip').textContent).toContain('$400.00');
  expect(container.querySelector('.aic-tip').textContent).toContain('unusual day');
  await act(async () => { plot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
});
