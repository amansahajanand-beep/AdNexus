/* Preset AI analysis card: states, streaming, fallback, collapse, deep tier, request replacement. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../../utils/ai/presetAnalysis', () => ({
  loadAiStatus: jest.fn(),
  streamPresetAnalysis: jest.fn(),
  resetAiStatus: jest.fn(),
}));
jest.mock('../../utils/api', () => ({
  aiAPI: { feedback: jest.fn().mockResolvedValue({ ok: true }) },
}));
jest.mock('../../hooks/useToast', () => ({ showToast: jest.fn() }));

import { loadAiStatus, streamPresetAnalysis } from '../../utils/ai/presetAnalysis';
import { aiAPI } from '../../utils/api';
import PresetAiAnalysis from './PresetAiAnalysis';

global.IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 320) => { await act(async () => { await wait(ms); }); };

const RESULT = {
  analysis: {
    headline: 'Earnings are up and two sites carry most of it.',
    summary: 'Growth came from volume.',
    findings: [{ severity: 'warning', title: 'Two sites carry 67% of earnings', detail: 'A problem there would move the result.', factIds: ['F1'] }],
    actions: [{ title: 'Grow the other sites', detail: 'Add more traffic.', factIds: [] }],
    deepDive: [{ title: 'Where growth came from', body: 'Two sites doubled.', factIds: ['F1'] }],
    confidence: { level: 'high', note: 'Plenty of data.' },
  },
  facts: { F1: { display: 'Estimated earnings $603.49 (+120.1% vs prior)' } },
  meta: {
    source: 'ai', cached: false, analysisId: 'abc', dataSyncedAt: '2026-10-01T09:20:00.000Z', factsMs: 120, aiMs: 1300, error: null,
  },
};

let container;
let root;

async function mount(props = {}) {
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PresetAiAnalysis product="adsense" kind="dashboard" filters={{}} startDate="2026-09-24" endDate="2026-09-30" {...props} />
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.clear();
  jest.clearAllMocks();
  loadAiStatus.mockResolvedValue({ enabled: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('renders nothing when AI is off', async () => {
  loadAiStatus.mockResolvedValue({ enabled: false });
  await mount();
  await flush();
  expect(container.innerHTML).toBe('');
  expect(streamPresetAnalysis).not.toHaveBeenCalled();
});

test('shows key figures and the headline while loading, then the full result', async () => {
  let finish;
  streamPresetAnalysis.mockImplementation((body, { onFacts, onHeadline }) => new Promise((resolve) => {
    onFacts({ facts: { F1: { display: 'Estimated earnings $603.49' } }, metricIds: ['F1'], signals: [] });
    onHeadline('Earnings are up and two sites carry most of it.');
    finish = () => resolve(RESULT);
  }));
  await mount();
  await flush();
  expect(container.textContent).toContain('Estimated earnings $603.49');
  expect(container.textContent).toContain('Earnings are up and two sites carry most of it.');
  expect(container.querySelector('.pai-skel')).not.toBeNull();

  await act(async () => { finish(); await wait(10); });
  expect(container.textContent).toContain('Two sites carry 67% of earnings');
  expect(container.textContent).toContain('Estimated earnings $603.49 (+120.1% vs prior)');
  expect(container.textContent).toContain('Grow the other sites');
  expect(container.textContent).toContain('Ready in');
  expect(container.querySelector('.pai-skel')).toBeNull();
  expect(streamPresetAnalysis.mock.calls[0][0]).toMatchObject({ product: 'adsense', kind: 'dashboard', depth: 'fast', startDate: '2026-09-24' });
});

test('shows a rule-based notice when the model was unavailable', async () => {
  streamPresetAnalysis.mockResolvedValue({
    ...RESULT, meta: { ...RESULT.meta, source: 'rules', error: { code: 'ai_timeout', message: 'slow' } },
  });
  await mount();
  await flush();
  expect(container.textContent).toContain('The AI summary is unavailable right now');
  expect(container.textContent).toContain('Try AI again');
  expect(container.textContent).toContain('rule-based');
  expect(container.textContent).not.toContain('Was this useful?');
});

test('a request failure shows a message with a retry', async () => {
  streamPresetAnalysis.mockRejectedValue(Object.assign(new Error('Admin access required'), { status: 403 }));
  await mount();
  await flush();
  expect(container.textContent).toContain('Admin access required');
  expect(container.textContent).toContain('Try again');
});

test('deep analysis runs only when asked and shows the deep dive', async () => {
  streamPresetAnalysis.mockResolvedValue(RESULT);
  await mount();
  await flush();
  expect(streamPresetAnalysis).toHaveBeenCalledTimes(1);
  const deepBtn = [...container.querySelectorAll('.pai-seg button')].find((b) => b.textContent === 'Deep analysis');
  await act(async () => { deepBtn.click(); await wait(10); });
  expect(streamPresetAnalysis).toHaveBeenCalledTimes(2);
  expect(streamPresetAnalysis.mock.calls[1][0].depth).toBe('deep');
  expect(container.textContent).toContain('Where growth came from');
  expect(container.textContent).toContain('Confidence: high');
});

test('collapsing stops requests and is remembered', async () => {
  streamPresetAnalysis.mockResolvedValue(RESULT);
  localStorage.setItem('adnexus.presetAi.collapsed', '1');
  await mount();
  await flush();
  expect(streamPresetAnalysis).not.toHaveBeenCalled();
  expect(container.querySelector('.pai-body')).toBeNull();
  const toggle = container.querySelector('.pai-toggle');
  await act(async () => { toggle.click(); });
  await flush();
  expect(streamPresetAnalysis).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('adnexus.presetAi.collapsed')).toBe('0');
});

test('changing the date range cancels the old request and starts a new one', async () => {
  const signals = [];
  streamPresetAnalysis.mockImplementation((body, { signal }) => { signals.push(signal); return new Promise(() => {}); });
  await mount();
  await flush();
  expect(signals).toHaveLength(1);
  await act(async () => {
    root.render(
      <PresetAiAnalysis product="adsense" kind="dashboard" filters={{}} startDate="2026-09-17" endDate="2026-09-23" />
    );
  });
  await flush();
  expect(signals[0].aborted).toBe(true);
  expect(signals).toHaveLength(2);
  expect(streamPresetAnalysis.mock.calls[1][0].startDate).toBe('2026-09-17');
});

test('feedback is sent once per choice', async () => {
  streamPresetAnalysis.mockResolvedValue(RESULT);
  await mount();
  await flush();
  const yes = [...container.querySelectorAll('.pai-fb button')].find((b) => b.textContent === 'Yes');
  await act(async () => { yes.click(); await wait(10); });
  expect(aiAPI.feedback).toHaveBeenCalledWith({ feature: 'preset-analysis', targetKey: 'abc', rating: 'up' });
});
