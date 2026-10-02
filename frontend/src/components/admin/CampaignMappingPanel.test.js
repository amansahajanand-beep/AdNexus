/* Campaign mapping panel: pre-selection, grouping of saves, manual choice, empty states. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../../utils/api', () => ({
  mappingAPI: { suggest: jest.fn(), listMaps: jest.fn(), saveBulk: jest.fn(), deleteMap: jest.fn() },
}));
jest.mock('../../hooks/useToast', () => ({ showToast: jest.fn() }));
jest.mock('../../hooks/useConfirmDialog', () => ({ confirmDialog: jest.fn() }));

import { mappingAPI } from '../../utils/api';
import { confirmDialog } from '../../hooks/useConfirmDialog';
import CampaignMappingPanel from './CampaignMappingPanel';

global.IS_REACT_ACT_ENVIRONMENT = true;

const T = (key) => ({ type: 'site', key, label: key });
const sug = (id, name, target, confidence, extra = {}) => ({
  adsAccountId: 'acc1', accountName: 'Account One', campaignId: id, campaignName: name, spend: 100,
  alternatives: target ? [{ ...target, score: 0.9 }] : [], target, confidence, source: 'rules', reason: 'matched', ...extra,
});

const DATA = {
  suggestions: [
    sug('c1', 'Quiz2 Search', T('quiz2.example.com'), 'high'),
    sug('c2', 'Quiz2 Display', T('quiz2.example.com'), 'medium'),
    sug('c3', 'Game6 Video', T('game6.example.com'), 'low', { source: 'ai' }),
    sug('c4', 'Mystery', null, 'none'),
  ],
  targets: [T('quiz2.example.com'), T('game6.example.com'), T('other.example.com')],
  stats: { unmappedCampaigns: 4, alreadyMapped: 1, suggested: 3, ai: { used: true, asked: 2, model: 'm', error: null } },
};

let container;
let root;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

async function mount(props = {}) {
  root = createRoot(container);
  await act(async () => { root.render(<CampaignMappingPanel product="adsense" clientId="ws1" {...props} />); });
  await tick();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
  mappingAPI.suggest.mockResolvedValue(DATA);
  mappingAPI.listMaps.mockResolvedValue({ maps: [{ id: 'm1', campaignName: 'Old one', accountName: 'Account One', targetType: 'site', targetKey: 'x.com' }] });
  mappingAPI.saveBulk.mockResolvedValue({ saved: 1 });
  mappingAPI.deleteMap.mockResolvedValue({});
  confirmDialog.mockResolvedValue(true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const checkboxes = () => [...container.querySelectorAll('tbody input[type="checkbox"]')];
const saveBtn = () => [...container.querySelectorAll('button')].find((b) => /^Save( \d+)? mapping/.test(b.textContent));

test('loads suggestions for the pinned workspace and ticks only likely matches', async () => {
  await mount();
  expect(mappingAPI.suggest).toHaveBeenCalledWith({ product: 'adsense' }, 'ws1');
  expect(container.textContent).toContain('Quiz2 Search');
  expect(checkboxes().map((c) => c.checked)).toEqual([true, true, false, false]);
  expect(checkboxes()[3].disabled).toBe(true); // no target chosen yet
  expect(saveBtn().textContent).toBe('Save 2 mappings');
  expect(container.textContent).toContain('AI helped with 2 unclear campaigns');
});

test('saving groups campaigns that share a target into one request', async () => {
  await mount();
  await act(async () => { saveBtn().click(); });
  await tick();
  expect(mappingAPI.saveBulk).toHaveBeenCalledTimes(1);
  expect(mappingAPI.saveBulk).toHaveBeenCalledWith({
    adsAccountId: 'acc1',
    targetType: 'site',
    targetKey: 'quiz2.example.com',
    campaigns: [
      { campaignId: 'c1', campaignName: 'Quiz2 Search' },
      { campaignId: 'c2', campaignName: 'Quiz2 Display' },
    ],
  }, 'ws1');
  expect(mappingAPI.suggest).toHaveBeenCalledTimes(2); // list refreshed after saving
});

test('choosing a target by hand ticks the row and is saved to that target', async () => {
  await mount();
  const select = container.querySelector('select[aria-label="Target for Mystery"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'other.example.com');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(checkboxes()[3].checked).toBe(true);
  expect(saveBtn().textContent).toBe('Save 3 mappings');
  await act(async () => { saveBtn().click(); });
  await tick();
  const calls = mappingAPI.saveBulk.mock.calls.map((c) => `${c[0].targetKey}:${c[0].campaigns.map((x) => x.campaignId).join('+')}`);
  expect(calls).toEqual(expect.arrayContaining(['quiz2.example.com:c1+c2', 'other.example.com:c4']));
});

test('saved mappings can be listed and removed', async () => {
  await mount();
  const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Saved mappings'));
  await act(async () => { toggle.click(); });
  expect(container.textContent).toContain('Old one');
  const remove = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
  await act(async () => { remove.click(); });
  await tick();
  expect(mappingAPI.deleteMap).toHaveBeenCalledWith('m1', 'ws1');
});

test('explains when there is nothing to map to or nothing to map', async () => {
  mappingAPI.suggest.mockResolvedValue({ suggestions: [], targets: [], stats: { unmappedCampaigns: 0, ai: {} } });
  await mount();
  expect(container.textContent).toContain('No sites found yet');
  await act(async () => root.unmount());
  mappingAPI.suggest.mockResolvedValue({ suggestions: [], targets: [T('a.com')], stats: { unmappedCampaigns: 0, ai: {} } });
  root = createRoot(container);
  await act(async () => { root.render(<CampaignMappingPanel product="adsense" clientId="ws1" />); });
  await tick();
  expect(container.textContent).toContain('already mapped or matches on its own');
});

test('a failed load shows a message', async () => {
  mappingAPI.suggest.mockRejectedValue(new Error('boom'));
  await mount();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
