/* Forecast page: off state, figures before the explanation, status, tabs, target editor, chart views, errors. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../utils/api', () => ({ aiAPI: { setForecastTarget: jest.fn() } }));
jest.mock('../utils/ai/presetAnalysis', () => ({ loadAiStatus: jest.fn() }));
jest.mock('../utils/ai/forecast', () => ({ streamForecast: jest.fn() }));
jest.mock('../hooks/useToast', () => ({ showToast: jest.fn() }));
jest.mock('../utils/productWorkspace', () => ({ readStoredProduct: () => 'adsense' }));
jest.mock('../components/ui/PageHeader', () => function PageHeader({ title, subtitle, children }) {
  return <header><h1>{title}</h1><p>{subtitle}</p>{children}</header>;
});

import { aiAPI } from '../utils/api';
import { loadAiStatus } from '../utils/ai/presetAnalysis';
import { streamForecast } from '../utils/ai/forecast';
import AiForecast from './AiForecast';

global.IS_REACT_ACT_ENVIRONMENT = true;

const days = (start, n) => Array.from({ length: n }, (_, i) => `2026-09-${String(start + i).padStart(2, '0')}`);
const FIGURES = (over = {}) => ({
  product: 'adsense',
  label: 'AdSense',
  currency: 'USD',
  source: 'Daily earnings synced from Google',
  ok: true,
  reason: null,
  month: { start: '2026-09-01', end: '2026-09-30', today: '2026-09-16', elapsedDays: 15, daysInMonth: 30, name: 'September' },
  mtd: 1500,
  projectedEnd: { low: 2600, mid: 3000, high: 3500 },
  remainingDays: 15,
  remainingMid: 1500,
  dailyLevel: 100,
  lastMonth: { total: 2800, start: '2026-08-01', end: '2026-08-31', name: 'August' },
  paceVsLastMonthPct: 7.1,
  weekOverWeekPct: -3.2,
  target: null,
  status: 'ahead',
  basis: 'last_month',
  actual: [...days(1, 15).map((date) => ({ date, value: 100 }))],
  projected: days(16, 15).map((date) => ({ date, mid: 100, low: 70, high: 135 })),
  ...over,
});
const RESULT = (figures = FIGURES()) => ({
  figures,
  headline: 'AdSense is heading for about $3,000 in September.',
  explanation: 'It has earned $1,500 so far.',
  points: [{ text: 'That is above last month.', factIds: ['F1'] }],
  facts: { F1: { display: 'August total $2,800' } },
  meta: { source: 'ai', error: null },
});

let container;
let root;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
async function mount() {
  root = createRoot(container);
  await act(async () => { root.render(<AiForecast />); });
  await tick();
}
const button = (text) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
  loadAiStatus.mockResolvedValue({ enabled: true });
  streamForecast.mockResolvedValue(RESULT());
  aiAPI.setForecastTarget.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('says so when AI is off and does not load anything', async () => {
  loadAiStatus.mockResolvedValue({ enabled: false });
  await mount();
  expect(container.textContent).toContain('AI features are turned off');
  expect(streamForecast).not.toHaveBeenCalled();
});

test('opens on the stored product and shows the projection, range, status, tiles and explanation', async () => {
  await mount();
  expect(streamForecast.mock.calls[0][0]).toEqual({ product: 'adsense' });
  expect(container.querySelector('[aria-selected="true"]').textContent).toBe('AdSense');
  expect(container.querySelector('.fc-big-v').textContent).toBe('$3,000.00');
  expect(container.querySelector('.fc-range').textContent).toContain('$2,600.00');
  expect(container.querySelector('.fc-range').textContent).toContain('$3,500.00');
  expect(container.querySelector('.fc-status').textContent).toBe('Ahead of last month');
  const tiles = [...container.querySelectorAll('.fc-tiles li')].map((li) => li.textContent);
  expect(tiles[0]).toContain('$1,500.00');
  expect(tiles[0]).toContain('15 of 30 days');
  expect(tiles[1]).toContain('15 days left');
  expect(tiles[2]).toContain('August total');
  expect(tiles[2]).toContain('7.1%');
  expect(tiles[3]).toContain('3.2%');
  expect(container.querySelector('.fc-headline').textContent).toContain('about $3,000');
  expect(container.querySelector('.rep-facts').textContent).toContain('August total $2,800');
  expect(container.textContent).toContain('not a promise');
  expect(container.querySelector('.fc-chart svg')).not.toBeNull();
});

test('figures appear at once with the rule-based explanation, then the written one replaces it', async () => {
  let finish;
  streamForecast.mockImplementation((body, { onFigures }) => new Promise((resolve) => {
    onFigures({ ...FIGURES(), rules: { headline: 'Rules headline.', explanation: '', points: [] } });
    finish = () => resolve(RESULT());
  }));
  await mount();
  expect(container.querySelector('.fc-big-v').textContent).toBe('$3,000.00');
  expect(container.textContent).toContain('Rules headline.');
  expect(container.textContent).toContain('Writing the explanation');
  await act(async () => { finish(); });
  await tick();
  expect(container.textContent).not.toContain('Rules headline.');
  expect(container.textContent).not.toContain('Writing the explanation');
  expect(container.textContent).toContain('about $3,000 in September');
  expect(container.textContent).toContain('AI summary');
});

test('target statuses read in plain words', async () => {
  for (const [status, text] of [['will_reach', 'Likely to reach the target'], ['at_risk', 'At risk of missing the target'], ['will_miss', 'Likely to miss the target'], ['behind', 'Behind last month']]) {
    streamForecast.mockResolvedValue(RESULT(FIGURES({ status, target: status === 'behind' ? null : 4000 })));
    await act(async () => root?.unmount());
    root = createRoot(container);
    await act(async () => { root.render(<AiForecast />); });
    await tick();
    expect(container.querySelector('.fc-status').textContent).toBe(text);
  }
});

test('switching product loads that product', async () => {
  await mount();
  streamForecast.mockResolvedValue(RESULT(FIGURES({ product: 'gam', label: 'Google Ad Manager' })));
  await act(async () => { button('Google Ad Manager').click(); });
  await tick();
  expect(streamForecast.mock.calls[1][0]).toEqual({ product: 'gam' });
  expect(container.querySelector('[aria-selected="true"]').textContent).toBe('Google Ad Manager');
});

test('saving a target sends it and reloads; removing clears it', async () => {
  await mount();
  const input = container.querySelector('#fc-target-input');
  expect(button('Save target').disabled).toBe(true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '4,500abc');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('4500');
  streamForecast.mockResolvedValue(RESULT(FIGURES({ target: 4500, status: 'will_miss', basis: 'target' })));
  await act(async () => { button('Save target').click(); });
  await tick();
  expect(aiAPI.setForecastTarget).toHaveBeenCalledWith('adsense', 4500);
  expect(streamForecast).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.fc-status').textContent).toBe('Likely to miss the target');
  expect(container.querySelector('#fc-target-input').value).toBe('4500');

  streamForecast.mockResolvedValue(RESULT());
  await act(async () => { button('Remove').click(); });
  await tick();
  expect(aiAPI.setForecastTarget).toHaveBeenLastCalledWith('adsense', 0);
  expect(button('Remove')).toBeUndefined();
});

test('the chart switches between month total (with target and last month) and daily', async () => {
  streamForecast.mockResolvedValue(RESULT(FIGURES({ target: 3600 })));
  await mount();
  expect(container.querySelector('.fc-target-line')).not.toBeNull();
  expect(container.querySelector('.fc-last-line')).not.toBeNull();
  expect(container.querySelector('.fc-band')).not.toBeNull();
  expect(container.querySelector('.fc-proj-line')).not.toBeNull();
  await act(async () => { button('Daily').click(); });
  expect(container.querySelector('.fc-target-line')).toBeNull();
  expect(container.querySelector('.fc-chart-head .aic-cap-title').textContent).toBe('Day by day');
  expect(button('Daily').getAttribute('aria-pressed')).toBe('true');
});

test('not enough data shows why instead of a forecast', async () => {
  streamForecast.mockResolvedValue(RESULT(FIGURES({ ok: false, reason: 'Needs at least 14 days of earnings to forecast; there are 4.', projectedEnd: null, projected: [] })));
  await mount();
  expect(container.textContent).toContain('Not enough data to forecast AdSense yet');
  expect(container.textContent).toContain('at least 14 days');
  expect(container.querySelector('.fc-big-v')).toBeNull();
});

test('an error offers another try', async () => {
  streamForecast.mockRejectedValueOnce(new Error('The earnings data took too long to load.'));
  await mount();
  expect(container.querySelector('[role="alert"]').textContent).toContain('took too long');
  streamForecast.mockResolvedValue(RESULT());
  await act(async () => { button('Try again').click(); });
  await tick();
  expect(container.querySelector('.fc-big-v').textContent).toBe('$3,000.00');
});
