/* Publisher scope panel (AdMob / AdSense): account → items, filters, metrics & reports, legacy defaults. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

jest.mock('../../utils/api', () => ({
  admobAPI: { scopeCatalog: jest.fn() },
  adsenseAPI: { scopeCatalog: jest.fn() },
}));

import { adsenseAPI, admobAPI } from '../../utils/api';
import PublisherScopePanel, { scopeFromUser, EMPTY_ADSENSE_SCOPE, EMPTY_ADMOB_SCOPE } from './PublisherScopePanel';

global.IS_REACT_ACT_ENVIRONMENT = true;

const ADSENSE_CATALOG = {
  accounts: [{ id: 'a1', publisherId: 'pub-1', name: 'Main' }],
  sites: [{ key: 'a1:one.com', accountId: 'a1', name: 'one.com' }, { key: 'a1:two.com', accountId: 'a1', name: 'two.com' }],
};

let container;
let root;
let latest;
const tick = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

function Harness({ product, initial }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return <PublisherScopePanel product={product} value={value} onChange={setValue} />;
}

async function mount(product, initial) {
  root = createRoot(container);
  await act(async () => { root.render(<Harness product={product} initial={initial} />); });
  await tick();
}

const checkbox = (label) => [...container.querySelectorAll('label.perm-toggle')].find((l) => l.textContent === label)?.querySelector('input');
const click = async (el) => { await act(async () => { el.click(); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  jest.clearAllMocks();
  adsenseAPI.scopeCatalog.mockResolvedValue(ADSENSE_CATALOG);
  admobAPI.scopeCatalog.mockResolvedValue({ accounts: [], apps: [], adUnits: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('AdSense: publishers first; sites, filters, metrics and reports appear once a publisher is picked', async () => {
  await mount('adsense', { ...EMPTY_ADSENSE_SCOPE, accountIds: ['a1'] });
  expect(adsenseAPI.scopeCatalog).toHaveBeenCalled();
  const labels = [...container.querySelectorAll('.ui-field-label')].map((e) => e.textContent);
  expect(labels).toEqual([
    'AdSense — publisher accounts',
    'AdSense — sites (optional)',
    'AdSense — allowed filters & breakdowns',
    'AdSense — metrics',
    'AdSense — reports',
  ]);
  expect(container.textContent).not.toContain('ad units (optional)');
  expect(container.textContent).toContain('Page views & impressions');
  expect(container.textContent).toContain('RPM');
  expect([...container.querySelectorAll('label.perm-toggle')].map((l) => l.textContent)).toEqual([
    'Site', 'Country', 'Platform',
    'Revenue & earnings', 'Page views & impressions', 'CTR & clicks', 'RPM',
    'Dashboard', 'Reporting', 'Download CSV',
  ]);
});

test('toggling metrics and reports updates the scope', async () => {
  await mount('adsense', { ...EMPTY_ADSENSE_SCOPE, accountIds: ['a1'] });
  await click(checkbox('CTR & clicks'));
  await click(checkbox('Download CSV'));
  expect(latest.metrics).toEqual(['revenue', 'impressions', 'ecpm']);
  expect(latest.reports).toEqual(['dashboard', 'reporting']);
  await click(checkbox('Download CSV'));
  expect(latest.reports).toEqual(['dashboard', 'reporting', 'download']);
  await click(checkbox('Platform'));
  expect(latest.filters).toEqual(['site', 'country']);
});

test('AdMob keeps its apps and ad units and gets the same metrics and reports', async () => {
  await mount('admob', { ...EMPTY_ADMOB_SCOPE, accountIds: ['x'] });
  const labels = [...container.querySelectorAll('.ui-field-label')].map((e) => e.textContent);
  expect(labels).toEqual([
    'AdMob — publisher accounts', 'AdMob — apps (optional)', 'AdMob — ad units (optional)',
    'AdMob — allowed filters & breakdowns', 'AdMob — metrics', 'AdMob — reports',
  ]);
  expect(container.textContent).toContain('eCPM & match rate');
});

test('nothing but the publisher list is shown until a publisher is picked', async () => {
  await mount('adsense', { ...EMPTY_ADSENSE_SCOPE });
  expect([...container.querySelectorAll('.ui-field-label')].map((e) => e.textContent)).toEqual(['AdSense — publisher accounts']);
});

test('users saved before per-product metrics keep what their general flags allowed', () => {
  const user = {
    permissions: {
      canSeeRevenue: false, canSeeECPM: false, canDownloadReports: false,
      adsenseScope: { accountIds: ['a1'], sites: ['a1:one.com'], filters: ['site'] },
    },
  };
  expect(scopeFromUser(user, 'adsense')).toEqual({
    accountIds: ['a1'], sites: ['a1:one.com'], filters: ['site'], metrics: ['impressions', 'ctr'], reports: ['dashboard', 'reporting'],
  });
  expect(scopeFromUser({ permissions: {} }, 'adsense')).toEqual(EMPTY_ADSENSE_SCOPE);
  const saved = scopeFromUser({ permissions: { admobScope: { accountIds: ['x'], apps: [], adUnits: [], filters: ['app'], metrics: ['revenue'], reports: ['dashboard'] } } }, 'admob');
  expect(saved.metrics).toEqual(['revenue']);
  expect(saved.reports).toEqual(['dashboard']);
});
