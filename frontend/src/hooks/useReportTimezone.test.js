/* The shared timezone choice: stored once, sent on AI requests, and used for "today" while a page shows it. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const mockDispatch = jest.fn();
jest.mock('react-redux', () => ({ useDispatch: () => mockDispatch }));
jest.mock('../store/slices/reportSlice', () => ({ saveReportPage: (a) => ({ type: 'save', ...a }) }));
jest.mock('../utils/api', () => ({ reportsAPI: { getTimezones: jest.fn() } }));

import { reportsAPI } from '../utils/api';
import useReportTimezone from './useReportTimezone';
import { getReportTz, setReportTz, reportTzHeaders } from '../utils/reportTimezone';
import { getActiveTimezone, todayInTZ, APP_TIMEZONE } from '../utils/datetime';

global.IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = {
  networkTz: 'America/New_York',
  options: [{ id: 'America/New_York', label: 'New York (network)' }, { id: 'Asia/Kolkata', label: 'India (Kolkata)' }],
  hourlyFrom: '2026-09-16',
  stale: false,
};

let container;
let root;
let latest;
function Probe() {
  latest = useReportTimezone();
  return null;
}
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
  window.localStorage.clear();
  setReportTz('');
  reportsAPI.getTimezones.mockResolvedValue(OPTIONS);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
});

async function mount() {
  root = createRoot(container);
  await act(async () => { root.render(<Probe />); });
  await tick();
}

test('the choice is stored, shared and turned into a request header', () => {
  expect(reportTzHeaders()).toEqual({});
  setReportTz('Asia/Kolkata');
  expect(getReportTz()).toBe('Asia/Kolkata');
  expect(window.localStorage.getItem('adnexus.report.tz')).toBe('Asia/Kolkata');
  expect(reportTzHeaders()).toEqual({ 'X-Report-Tz': 'Asia/Kolkata' });
  setReportTz('');
  expect(window.localStorage.getItem('adnexus.report.tz')).toBeNull();
  expect(reportTzHeaders()).toEqual({});
});

test('while a page shows the network zone, "today" is that zone\'s date; leaving restores the default', async () => {
  await mount();
  expect(latest.options.networkTz).toBe('America/New_York');
  expect(getActiveTimezone()).toBe('America/New_York');
  expect(todayInTZ()).toBe(todayInTZ('America/New_York'));
  await act(async () => root.unmount());
  root = null;
  expect(getActiveTimezone()).toBe(APP_TIMEZONE);
});

test('picking a zone applies it everywhere, makes "today" follow it, and clears the saved page filters', async () => {
  await mount();
  await act(async () => { latest.change('Asia/Kolkata'); });
  await tick();
  expect(getReportTz()).toBe('Asia/Kolkata');
  expect(latest.tz).toBe('Asia/Kolkata');
  expect(getActiveTimezone()).toBe('Asia/Kolkata');
  expect(todayInTZ()).toBe(todayInTZ('Asia/Kolkata'));
  expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ pageKey: 'dashboard', payload: null }));
  expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ pageKey: 'reporting', payload: null }));
  expect(reportsAPI.getTimezones).toHaveBeenLastCalledWith('Asia/Kolkata');

  // choosing the shown network's own zone stays a choice, so other networks (combined Dashboard) follow it too
  await act(async () => { latest.change('America/New_York'); });
  expect(getReportTz()).toBe('America/New_York');
});

test('a choice made elsewhere (another component) reaches the page', async () => {
  await mount();
  await act(async () => { setReportTz('Asia/Kolkata'); });
  expect(latest.tz).toBe('Asia/Kolkata');
});

test('the AI event stream sends the chosen timezone', async () => {
  jest.resetModules();
  if (typeof global.TextDecoder === 'undefined') global.TextDecoder = require('util').TextDecoder;
  jest.doMock('../utils/api', () => ({ getToken: () => 'tok', reportsAPI: {} }));
  const { postEventStream } = require('../utils/ai/eventStream');
  const { setReportTz: set } = require('../utils/reportTimezone');
  const calls = [];
  global.fetch = jest.fn((url, init) => {
    calls.push(init.headers);
    return Promise.resolve({ ok: true, body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) } });
  });
  set('Asia/Kolkata');
  await postEventStream('/ai/ask', { question: 'x' });
  set('');
  await postEventStream('/ai/ask', { question: 'x' });
  expect(calls[0]['X-Report-Tz']).toBe('Asia/Kolkata');
  expect(calls[0].Authorization).toBe('Bearer tok');
  expect(calls[1]['X-Report-Tz']).toBeUndefined();
});
