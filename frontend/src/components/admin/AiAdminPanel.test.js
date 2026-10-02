/* Admin AI panel: states (server off, no credentials, account off, on), toggle, connection test, usage. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../../utils/api', () => ({ aiAPI: { admin: jest.fn(), setEnabled: jest.fn(), ping: jest.fn(), tokenSeries: jest.fn() } }));
jest.mock('../../utils/ai/presetAnalysis', () => ({ resetAiStatus: jest.fn() }));
jest.mock('../../hooks/useToast', () => ({ showToast: jest.fn() }));

import { aiAPI } from '../../utils/api';
import { resetAiStatus } from '../../utils/ai/presetAnalysis';
import AiAdminPanel from './AiAdminPanel';

global.IS_REACT_ACT_ENVIRONMENT = true;

const daily = Array.from({ length: 14 }, (_, i) => ({ day: `2026-09-${String(19 + i).padStart(2, '0')}`, calls: i, failures: i === 3 ? 1 : 0, tokens: i * 100 }));
const overview = (over = {}) => ({
  server: {
    enabled: true,
    defaultForAccounts: false,
    provider: {
      kind: 'openai', host: 'integrate.api.nvidia.com', credentials: true,
      models: { fast: 'nvidia/nemotron', deep: 'nvidia/nemotron', chat: 'nvidia/nemotron' },
      thinking: { fast: false, deep: false, chat: false }, jsonMode: false,
      timeoutsSec: { fast: 90, deep: 120, chat: 90 },
    },
    ...over.server,
  },
  account: { enabled: true, reason: null, setting: true, ...over.account },
  limits: { requestsPerMinute: 10, userTokens: 1200, userLimit: 300000, clientTokens: 5000, clientLimit: 3000000 },
  jobs: { alerts: true, weeklyReport: false, prewarm: false },
  usage: {
    days: 7,
    features: [{ feature: 'preset-analysis', calls: 5, ok: 4, cache_hits: 3, failures: 1, p50_ms: 14000, p95_ms: 41000, input_tokens: 5000, output_tokens: 2000 }],
    totals: { calls: 5, failures: 1, cacheHits: 3, inputTokens: 5000, outputTokens: 2000, cost: 0, up: 2, down: 1 },
    daily,
  },
  tokens: {
    averagesDays: 90,
    averages: [
      { feature: 'preset-analysis', requests: 4, avgInput: 1250, avgOutput: 500, avgTotal: 1750 },
      { feature: 'ask-data', requests: 2, avgInput: 900, avgOutput: 100, avgTotal: 1000 },
    ],
    series: { by: 'day', rows: daily.map((d) => ({ period: d.day, input: d.tokens, output: 0, tokens: d.tokens, requests: d.calls })) },
  },
  feedback: { up: 2, down: 1, recent: [{ feature: 'ask-data', rating: -1, comment: 'wrong dates', createdAt: '2026-10-01T10:00:00Z' }] },
  failures: [{ feature: 'preset-analysis', status: 'fallback', code: 'ai_timeout', createdAt: '2026-10-01T09:00:00Z' }],
});

let container;
let root;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
async function mount() {
  root = createRoot(container);
  await act(async () => { root.render(<AiAdminPanel />); });
  await tick();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
  aiAPI.admin.mockResolvedValue(overview());
  aiAPI.setEnabled.mockResolvedValue({ enabled: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const sw = () => container.querySelector('#ai-account-switch');

test('on: shows state, usage, friendly feature names, feedback and problems', async () => {
  await mount();
  expect(container.textContent).toContain('AI is on for this account');
  expect(container.textContent).toContain('integrate.api.nvidia.com');
  expect(container.textContent).toContain('Preset analysis');
  expect(container.textContent).toContain('wrong dates');
  expect(container.textContent).toContain('Fell back');
  expect(container.textContent).toContain('timeout');
  expect(container.querySelectorAll('.aia-bar-col')).toHaveLength(14);
  expect(container.textContent).toContain('2 helpful · 1 not helpful');
  expect(container.querySelector('.aia-badge.on')).not.toBeNull();
  expect(sw().checked).toBe(true);
});

test('token consumption: averages per request, and the chart switches between day, month and year', async () => {
  await mount();
  const preset = container.querySelector('[data-testid="avg-preset-analysis"]');
  expect(preset.textContent).toContain('1,750');
  expect(preset.textContent).toContain('1,250 in · 500 out · 4 requests');
  const report = container.querySelector('[data-testid="avg-weekly-report"]');
  expect(report.textContent).toContain('—');
  expect(report.textContent).toContain('No requests in the last 90 days');
  const ask = container.querySelector('[data-testid="avg-ask-data"]');
  expect(ask.textContent).toContain('1,000');
  expect(ask.textContent).toContain('900 in · 100 out · 2 requests');
  expect(container.querySelectorAll('.aia-bar-col')).toHaveLength(14);
  expect(container.textContent).toContain('Last 30 days');

  aiAPI.tokenSeries.mockResolvedValue({ by: 'month', rows: [{ period: '2026-08', input: 10, output: 5, tokens: 15, requests: 1 }, { period: '2026-09', input: 100, output: 50, tokens: 150, requests: 3 }] });
  const month = [...container.querySelectorAll('.aia-range-btn')].find((b) => b.textContent === 'Month');
  await act(async () => { month.click(); });
  await tick();
  expect(aiAPI.tokenSeries).toHaveBeenCalledWith('month');
  expect(container.querySelectorAll('.aia-bar-col')).toHaveLength(2);
  expect(container.textContent).toContain('Last 12 months');
  expect(container.textContent).toContain('165 in total');
  expect(month.getAttribute('aria-pressed')).toBe('true');

  aiAPI.tokenSeries.mockRejectedValue(new Error('boom'));
  const year = [...container.querySelectorAll('.aia-range-btn')].find((b) => b.textContent === 'Year');
  await act(async () => { year.click(); });
  await tick();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

test('account off: explains and lets an admin turn it on', async () => {
  aiAPI.admin.mockResolvedValue(overview({ account: { enabled: false, reason: 'account_off', setting: false } }));
  await mount();
  expect(container.textContent).toContain('AI is off for this account');
  expect(container.textContent).toContain('Turn the switch below on');
  expect(sw().checked).toBe(false);
  await act(async () => { sw().click(); });
  await tick();
  expect(aiAPI.setEnabled).toHaveBeenCalledWith(true);
  expect(resetAiStatus).toHaveBeenCalled();
  expect(aiAPI.admin).toHaveBeenCalledTimes(2);
});

test('server off: says what to change and disables the switch and the test', async () => {
  aiAPI.admin.mockResolvedValue(overview({ server: { enabled: false }, account: { enabled: false, reason: 'server_off', setting: null } }));
  await mount();
  expect(container.textContent).toContain('AI_ENABLED=true');
  expect(sw().disabled).toBe(true);
  const test = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Test connection');
  expect(test.disabled).toBe(true);
});

test('missing credentials name the variables for the active provider', async () => {
  aiAPI.admin.mockResolvedValue(overview({
    server: { provider: { ...overview().server.provider, credentials: false } },
    account: { enabled: false, reason: 'no_credentials', setting: null },
  }));
  await mount();
  expect(container.textContent).toContain('AI_API_URL, AI_API_KEY and AI_MODEL');
  expect(sw().disabled).toBe(true);
});

test('connection test shows each tier with its time or its error', async () => {
  aiAPI.ping.mockResolvedValue({ results: { fast: { ok: true, latencyMs: 1500 }, deep: { ok: false, error: 'AI is busy. Try again shortly.' }, chat: { ok: true, latencyMs: 900 } } });
  await mount();
  const test = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Test connection');
  await act(async () => { test.click(); });
  await tick();
  const rows = [...container.querySelectorAll('.aia-test li')].map((li) => li.textContent);
  expect(rows).toEqual(['SummaryAnswered in 1.5 s', 'Deep analysisAI is busy. Try again shortly.', 'Ask AIAnswered in 0.9 s']);
});

test('a load failure shows a message', async () => {
  aiAPI.admin.mockRejectedValue(new Error('boom'));
  await mount();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
