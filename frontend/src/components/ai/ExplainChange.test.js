/* "Why did it change?": starts on click, shows figures first, then the explanation; stale answers are dropped. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../../utils/ai/explain', () => ({ streamExplainChange: jest.fn() }));

import { streamExplainChange } from '../../utils/ai/explain';
import ExplainChange from './ExplainChange';

global.IS_REACT_ACT_ENVIRONMENT = true;

const DRIVERS = {
  currency: 'USD',
  period: { start: '2026-09-24', end: '2026-09-30' },
  comparedWith: { start: '2026-09-17', end: '2026-09-23' },
  totals: {
    earningsNow: 133954.94, earningsPrev: 160821.43, delta: -26866.49, changePct: -16.7,
    volumeChangePct: -14.5, priceChangePct: -2.5, volumeUnit: 'impressions', priceName: 'eCPM',
  },
  aggregate: { delta: -26866.49, volume: -23366.09, price: -3500.4 },
  dimensions: [{
    by: 'Site',
    effects: { pureVolume: -9000, mix: -1000, price: -3500, newItems: 0, lostItems: -500, other: -12866.49 },
    concentrationPct: 80,
    items: [
      { name: 'alpha.example.com', delta: -14000, volume: -12000, price: -2000, now: 20000, prev: 34000, status: null, sharePct: 52.1 },
      { name: 'old.example.com', delta: -500, volume: -500, price: 0, now: 0, prev: 500, status: 'lost', sharePct: 1.9 },
    ],
  }],
  tooSmall: false,
  note: null,
  rules: { headline: 'Rules headline: earnings fell mostly because impressions fell.', explanation: '', points: [] },
};
const RESULT = {
  drivers: DRIVERS,
  headline: 'Earnings fell 16.7%, mostly because impressions dropped.',
  explanation: 'Traffic explains most of the drop.',
  points: [{ text: 'alpha.example.com lost the most.', factIds: ['F4'] }],
  facts: { F4: { display: 'Site alpha.example.com −$14,000.00' } },
  meta: { source: 'ai', error: null },
};

let container;
let root;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
async function mount(props = {}) {
  root = createRoot(container);
  await act(async () => { root.render(<ExplainChange product="gam" startDate="2026-09-24" endDate="2026-09-30" {...props} />); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('does nothing until asked, then shows figures first and the explanation after', async () => {
  let finish;
  streamExplainChange.mockImplementation((body, { onDrivers }) => new Promise((resolve) => {
    onDrivers(DRIVERS);
    finish = () => resolve(RESULT);
  }));
  await mount({ filters: { sites: ['a'] } });
  expect(streamExplainChange).not.toHaveBeenCalled();
  await act(async () => { container.querySelector('.exc-start').click(); });
  await tick();
  expect(streamExplainChange.mock.calls[0][0]).toEqual({ product: 'gam', startDate: '2026-09-24', endDate: '2026-09-30', filters: { sites: ['a'] } });

  // figures and the rule-based headline are visible while the model writes
  expect(container.textContent).toContain('Rules headline');
  expect(container.textContent).toContain('Writing the explanation');
  expect(container.textContent).toContain('alpha.example.com');
  expect(container.textContent).toContain('−$14,000.00');
  expect(container.textContent).toContain('52% of the change');
  expect(container.textContent).toContain('stopped earning');
  const rows = [...container.querySelectorAll('.exc-bar-row')].map((r) => r.querySelector('.exc-bar-label').textContent);
  expect(rows).toEqual(['Traffic change', 'Shift between items', 'Price change within items', 'Items that disappeared', 'Not attributed to a listed item']);
  expect(container.querySelectorAll('.exc-bar.neg').length).toBe(5);

  await act(async () => { finish(); });
  await tick();
  expect(container.textContent).toContain('Earnings fell 16.7%, mostly because impressions dropped.');
  expect(container.textContent).toContain('Traffic explains most of the drop.');
  expect(container.textContent).toContain('Site alpha.example.com −$14,000.00');
  expect(container.textContent).not.toContain('Writing the explanation');
});

test('without a breakdown only traffic and price are shown', async () => {
  streamExplainChange.mockResolvedValue({ ...RESULT, drivers: { ...DRIVERS, dimensions: [] } });
  await mount();
  await act(async () => { container.querySelector('.exc-start').click(); });
  await tick();
  expect([...container.querySelectorAll('.exc-bar-label')].map((e) => e.textContent)).toEqual(['Traffic change', 'Price change']);
});

test('a tiny change says so instead of showing bars', async () => {
  streamExplainChange.mockResolvedValue({ drivers: { ...DRIVERS, tooSmall: true }, headline: 'The change is too small to explain.', explanation: '', points: [], facts: {}, meta: { source: 'rules' } });
  await mount();
  await act(async () => { container.querySelector('.exc-start').click(); });
  await tick();
  expect(container.textContent).toContain('too small to explain');
  expect(container.querySelector('.exc-bars')).toBeNull();
});

test('an error offers a retry, and a changed period discards the old answer', async () => {
  streamExplainChange.mockRejectedValueOnce(new Error('Revenue is hidden for this account.'));
  await mount();
  await act(async () => { container.querySelector('.exc-start').click(); });
  await tick();
  expect(container.querySelector('[role="alert"]').textContent).toContain('Revenue is hidden');

  streamExplainChange.mockResolvedValueOnce(RESULT);
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
  await act(async () => { retry.click(); });
  await tick();
  expect(container.textContent).toContain('Traffic explains most of the drop.');

  await act(async () => { root.render(<ExplainChange product="gam" startDate="2026-09-17" endDate="2026-09-23" />); });
  expect(container.querySelector('.exc-start')).not.toBeNull();
  expect(container.textContent).not.toContain('Traffic explains');
});
