/* Admin user form: section order (AdMob, AdSense, then the date range last) and what is saved. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../../utils/api', () => ({
  admobAPI: { scopeCatalog: jest.fn() },
  adsenseAPI: { scopeCatalog: jest.fn() },
  reportsAPI: { getMergedFilterCatalog: jest.fn() },
  usersAPI: { getMergedInventoryPicker: jest.fn() },
}));

import { admobAPI, adsenseAPI, reportsAPI, usersAPI } from '../../utils/api';
import UserFormModal from './UserFormModal';

global.IS_REACT_ACT_ENVIRONMENT = true;

const USER = {
  id: 'u1',
  username: 'child_one',
  email: 'c@x.com',
  role: 'child',
  clientId: 'n1',
  permissions: {
    allowedClientIds: ['n1'],
    adsenseScope: { accountIds: ['a1'], sites: [], filters: ['site'], metrics: ['revenue'], reports: ['dashboard'] },
  },
};
const NETWORKS = [{ id: 'n1', name: 'Net', networkCode: '123' }];

let container;
let root;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
  admobAPI.scopeCatalog.mockResolvedValue({ accounts: [], apps: [], adUnits: [] });
  adsenseAPI.scopeCatalog.mockResolvedValue({ accounts: [{ id: 'a1', publisherId: 'pub-1', name: 'Main' }], sites: [] });
  reportsAPI.getMergedFilterCatalog.mockResolvedValue(null);
  usersAPI.getMergedInventoryPicker.mockResolvedValue({ siteHosts: [], appIds: [], domains: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(onSave = jest.fn()) {
  root = createRoot(container);
  await act(async () => {
    root.render(<UserFormModal open onClose={() => {}} onSave={onSave} user={USER} networks={NETWORKS} />);
  });
  await tick();
  return onSave;
}

const text = () => document.body.textContent;

test('AdMob and AdSense scopes come after the data scopes, and the date range is last', async () => {
  await mount();
  const labels = [...document.body.querySelectorAll('.ui-field-label')].map((e) => e.textContent);
  const at = (s) => labels.findIndex((l) => l.startsWith(s));
  expect(at('Data scope — assigned Google Ads accounts')).toBeGreaterThan(-1);
  expect(at('AdMob — publisher accounts')).toBeGreaterThan(at('Data scope — assigned Google Ads accounts'));
  expect(at('AdSense — publisher accounts')).toBeGreaterThan(at('AdMob — publisher accounts'));
  expect(at('Allowed date range')).toBeGreaterThan(at('AdSense — publisher accounts'));
  expect(labels[labels.length - 1]).toBe('Allowed date range (optional)');
  expect(labels.filter((l) => l.startsWith('Allowed date range'))).toHaveLength(1);
});

test('the old "AdMob access" heading and its note are gone', async () => {
  await mount();
  expect(text()).not.toContain('AdMob access');
  expect(text()).not.toContain('No publishers selected means this user has no AdMob access.');
});

test('saving sends the AdSense scope with its metrics and reports', async () => {
  const onSave = await mount();
  const save = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Save');
  await act(async () => { save.click(); });
  expect(onSave).toHaveBeenCalledTimes(1);
  const payload = onSave.mock.calls[0][0];
  expect(payload.adsenseScope).toMatchObject({ accountIds: ['a1'], filters: ['site'], metrics: ['revenue'], reports: ['dashboard'] });
  expect(payload.admobScope).toMatchObject({ accountIds: [] });
  expect(payload.admobScope.metrics).toEqual(['revenue', 'impressions', 'ctr', 'ecpm']);
});
