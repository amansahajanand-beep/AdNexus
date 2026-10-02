/* Weekly report page: AI off, empty state, latest report, history, generate, rule-based notice. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../utils/api', () => ({ aiAPI: { reports: jest.fn(), report: jest.fn(), generateReport: jest.fn() } }));
jest.mock('../utils/ai/presetAnalysis', () => ({ loadAiStatus: jest.fn() }));
jest.mock('../components/ui/PageHeader', () => function PageHeader({ title, subtitle, summary, children }) {
  return <header><h1>{title}</h1><p>{subtitle}</p><span className="ph-summary">{summary}</span>{children}</header>;
});

import { aiAPI } from '../utils/api';
import { loadAiStatus } from '../utils/ai/presetAnalysis';
import AiReport from './AiReport';

global.IS_REACT_ACT_ENVIRONMENT = true;

const REPORT = (id, source = 'ai') => ({
  id,
  periodStart: '2026-09-24',
  periodEnd: '2026-09-30',
  createdAt: '2026-10-01T02:00:00.000Z',
  source,
  content: {
    headline: `Headline ${id}`,
    summary: 'Summary text.',
    sections: [{ product: 'gam', summary: 'GAM summary.', points: [{ severity: 'warning', text: 'Revenue is down 17%', factIds: ['G-F1'] }] }],
    risks: [{ text: 'Revenue may keep falling', factIds: [] }],
    actions: [{ title: 'Check the top domains', detail: 'In Reporting.', factIds: [] }],
  },
  facts: { 'G-F1': 'Revenue $133,955 (−16.7% vs prior)' },
});

let container;
let root;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
async function mount() {
  root = createRoot(container);
  await act(async () => { root.render(<AiReport />); });
  await tick();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
  loadAiStatus.mockResolvedValue({ enabled: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('says so when AI is off', async () => {
  loadAiStatus.mockResolvedValue({ enabled: false });
  await mount();
  expect(container.textContent).toContain('AI features are turned off');
  expect(aiAPI.reports).not.toHaveBeenCalled();
});

test('empty state offers to write the first report', async () => {
  aiAPI.reports.mockResolvedValue({ reports: [] });
  await mount();
  expect(container.textContent).toContain('No report yet');
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent.startsWith('Write this week'));
  aiAPI.generateReport.mockResolvedValue({ report: REPORT(1) });
  aiAPI.reports.mockResolvedValue({ reports: [{ id: 1, periodStart: '2026-09-24', periodEnd: '2026-09-30', createdAt: '2026-10-01T02:00:00.000Z', source: 'ai' }] });
  await act(async () => { btn.click(); });
  await tick();
  expect(aiAPI.generateReport).toHaveBeenCalledWith(false);
  expect(container.textContent).toContain('Headline 1');
});

test('opens the latest report with facts, risks and actions; history switches reports', async () => {
  aiAPI.reports.mockResolvedValue({ reports: [
    { id: 2, periodStart: '2026-09-24', periodEnd: '2026-09-30', createdAt: '2026-10-01T02:00:00.000Z', source: 'ai' },
    { id: 1, periodStart: '2026-09-17', periodEnd: '2026-09-23', createdAt: '2026-09-24T02:00:00.000Z', source: 'rules' },
  ] });
  aiAPI.report.mockImplementation((id) => Promise.resolve({ report: REPORT(Number(id), Number(id) === 1 ? 'rules' : 'ai') }));
  await mount();
  expect(aiAPI.report).toHaveBeenCalledWith(2);
  expect(container.textContent).toContain('Headline 2');
  expect(container.textContent).toContain('Google Ad Manager');
  expect(container.textContent).toContain('Revenue $133,955 (−16.7% vs prior)');
  expect(container.textContent).toContain('Revenue may keep falling');
  expect(container.textContent).toContain('Check the top domains');
  expect(container.textContent).not.toContain('written from fixed rules');

  const select = container.querySelector('#rep-history');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, '1');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await tick();
  expect(container.textContent).toContain('Headline 1');
  expect(container.textContent).toContain('written from fixed rules');
});

test('writing a fresh report forces a new one when one is open', async () => {
  aiAPI.reports.mockResolvedValue({ reports: [{ id: 2, periodStart: '2026-09-24', periodEnd: '2026-09-30', createdAt: '2026-10-01T02:00:00.000Z', source: 'ai' }] });
  aiAPI.report.mockResolvedValue({ report: REPORT(2) });
  aiAPI.generateReport.mockResolvedValue({ report: REPORT(3) });
  await mount();
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Write a fresh report');
  await act(async () => { btn.click(); });
  await tick();
  expect(aiAPI.generateReport).toHaveBeenCalledWith(true);
  expect(container.textContent).toContain('Headline 3');
});
