/* AI alerts bell: visibility, unread badge, dismiss, check now. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../utils/api', () => ({
  aiAPI: { alerts: jest.fn(), scanAlerts: jest.fn(), dismissAlert: jest.fn() },
}));
jest.mock('../../utils/ai/presetAnalysis', () => ({ loadAiStatus: jest.fn() }));
jest.mock('../../hooks/useToast', () => ({ showToast: jest.fn() }));
jest.mock('../../utils/ai/explain', () => ({ streamExplainChange: jest.fn() }));

import { aiAPI } from '../../utils/api';
import { loadAiStatus } from '../../utils/ai/presetAnalysis';
import AiAlertsBell from './AiAlertsBell';

global.IS_REACT_ACT_ENVIRONMENT = true;

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
const ALERTS = [
  { id: 1, product: 'gam', page: 'dashboard', severity: 'critical', title: 'Revenue fell 31%', text: 'Revenue is $100.', createdAt: iso(5) },
  { id: 2, product: 'adsense', page: 'roi', severity: 'warning', title: 'ROI fell', text: 'ROI is 10%.', createdAt: iso(60 * 30) },
];

let container;
let root;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

async function mount(props = {}) {
  root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter><AiAlertsBell isAdmin {...props} /></MemoryRouter>); });
  await tick();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.clear();
  jest.clearAllMocks();
  loadAiStatus.mockResolvedValue({ enabled: true });
  aiAPI.alerts.mockResolvedValue({ alerts: ALERTS, scanning: false });
  aiAPI.dismissAlert.mockResolvedValue({ ok: true });
  aiAPI.scanAlerts.mockResolvedValue({ created: 1, alerts: ALERTS.slice(0, 1) });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('renders nothing for non-admins or when AI is off', async () => {
  await mount({ isAdmin: false });
  expect(container.innerHTML).toBe('');
  expect(aiAPI.alerts).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  loadAiStatus.mockResolvedValue({ enabled: false });
  root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter><AiAlertsBell isAdmin /></MemoryRouter>); });
  await tick();
  expect(container.innerHTML).toBe('');
});

test('badge counts alerts newer than the last time the list was opened', async () => {
  localStorage.setItem('adnexus.aiAlerts.seenAt', String(Date.now() - 60 * 60000));
  await mount();
  expect(container.querySelector('.aib-badge').textContent).toBe('1');
  await act(async () => { container.querySelector('.aib-btn').click(); });
  expect(container.querySelector('.aib-badge')).toBeNull();
  expect(container.textContent).toContain('Revenue fell 31%');
  expect(container.textContent).toContain('GAM');
  expect(container.textContent).toContain('Needs action');
  const links = [...container.querySelectorAll('.aib-link')].map((a) => a.getAttribute('href'));
  expect(links).toEqual(['/dashboard', '/adsense/roi']);
});

test('dismiss removes the alert and tells the server', async () => {
  await mount();
  await act(async () => { container.querySelector('.aib-btn').click(); });
  const dismiss = container.querySelector('.aib-dismiss');
  await act(async () => { dismiss.click(); });
  expect(aiAPI.dismissAlert).toHaveBeenCalledWith(1);
  expect(container.textContent).not.toContain('Revenue fell 31%');
  expect(container.textContent).toContain('ROI fell');
});

test('check now scans and shows the fresh list; an empty list says so', async () => {
  await mount();
  await act(async () => { container.querySelector('.aib-btn').click(); });
  const check = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Check now');
  await act(async () => { check.click(); });
  await tick();
  expect(aiAPI.scanAlerts).toHaveBeenCalled();
  expect(container.querySelectorAll('.aib-item')).toHaveLength(1);

  aiAPI.scanAlerts.mockResolvedValue({ created: 0, alerts: [] });
  await act(async () => { check.click(); });
  await tick();
  expect(container.textContent).toContain('Nothing needs attention right now.');
});

test('earnings alerts get a "Why did it change?" button; ROI and sync alerts do not', async () => {
  aiAPI.alerts.mockResolvedValue({
    alerts: [
      { id: 1, product: 'gam', page: 'dashboard', kind: 'metric_drop', severity: 'warning', title: 'Revenue is down 17%', text: 'x', createdAt: iso(5), periodStart: '2026-09-24', periodEnd: '2026-09-30' },
      { id: 2, product: 'admob', page: 'roi', kind: 'negative_roi', severity: 'critical', title: 'ROI is negative', text: 'y', createdAt: iso(5), periodStart: '2026-09-24', periodEnd: '2026-09-30' },
      { id: 3, product: 'adsense', page: 'dashboard', kind: 'stale_data', severity: 'warning', title: 'Data is out of date', text: 'z', createdAt: iso(5), periodStart: '2026-09-24', periodEnd: '2026-09-30' },
    ],
    scanning: false,
  });
  await mount();
  await act(async () => { container.querySelector('.aib-btn').click(); });
  const buttons = container.querySelectorAll('.exc-start');
  expect(buttons).toHaveLength(1);
  expect(buttons[0].closest('.aib-item').textContent).toContain('Revenue is down 17%');
});
