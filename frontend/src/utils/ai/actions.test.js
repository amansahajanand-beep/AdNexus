/* Chat action cards: what a click does (save a preset, set a target, open a page) and what it refuses. */
jest.mock('../api', () => ({
  aiAPI: { setForecastTarget: jest.fn() },
  presetsAPI: { savePage: jest.fn().mockResolvedValue({ version: 1 }), getAll: jest.fn().mockResolvedValue({ pages: {} }) },
}));

import { aiAPI } from '../api';
import { getReportPresets } from '../report/reportPresets';
import { hrefForAction, runAction } from './actions';

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  aiAPI.setForecastTarget.mockResolvedValue({ ok: true });
});

const SAVE = (over = {}) => ({
  id: 'a1', type: 'save_preset', product: 'adsense', page: 'reporting', presetPage: 'adsense-reporting', name: 'Top Site', snapshot: { sites: ['quiz2.example.com'] }, ...over,
});

test('save_preset stores the preset under the page and filter keys the page uses', async () => {
  const r = await runAction(SAVE(), { userId: 'u1' });
  expect(r).toMatchObject({ ok: true, href: '/adsense/presets', linkLabel: 'View presets' });
  const saved = getReportPresets('adsense-reporting', 'u1');
  expect(saved).toHaveLength(1);
  expect(saved[0].name).toBe('Top Site');
  expect(saved[0].snapshot.sites).toEqual(['quiz2.example.com']);
  expect(saved[0].summary).toContain('quiz2.example.com');
  expect(getReportPresets('adsense', 'u1')).toHaveLength(0);
  expect(getReportPresets('adsense-reporting', 'someone-else')).toHaveLength(0);
});

test('GAM filters keep their own keys; the product decides where "View presets" goes', async () => {
  const r = await runAction(SAVE({ product: 'gam', page: 'dashboard', presetPage: 'dashboard', name: 'GAM view', snapshot: { site: ['a.example.com'], domainId: ['com.app.one'], country: ['India'] } }), { userId: 'u1' });
  expect(r.href).toBe('/presets');
  expect(getReportPresets('dashboard', 'u1')[0].snapshot).toMatchObject({ site: ['a.example.com'], domainId: ['com.app.one'], country: ['India'] });
});

test('a name already used on that page is refused (any case), and nothing is saved twice', async () => {
  await runAction(SAVE(), { userId: 'u1' });
  const again = await runAction(SAVE({ id: 'a2', name: 'top site' }), { userId: 'u1' });
  expect(again.ok).toBe(false);
  expect(again.message).toMatch(/already exists/);
  expect(getReportPresets('adsense-reporting', 'u1')).toHaveLength(1);
});

test('an invalid name is reported, not silently dropped', async () => {
  const r = await runAction(SAVE({ name: 'bad<name>' }), { userId: 'u1' });
  expect(r.ok).toBe(false);
  expect(r.message).toMatch(/could not be saved/);
  expect(getReportPresets('adsense-reporting', 'u1')).toHaveLength(0);
});

test('the 50-preset limit is respected', async () => {
  for (let i = 0; i < 50; i += 1) await runAction(SAVE({ id: `p${i}`, name: `Preset ${i}` }), { userId: 'u1' });
  const r = await runAction(SAVE({ id: 'extra', name: 'One too many' }), { userId: 'u1' });
  expect(r.ok).toBe(false);
  expect(r.message).toMatch(/maximum of 50/);
});

test('set_forecast_target saves through the API, and says so when it fails', async () => {
  const set = await runAction({ id: 't', type: 'set_forecast_target', product: 'gam', amount: 600000 });
  expect(aiAPI.setForecastTarget).toHaveBeenCalledWith('gam', 600000);
  expect(set).toMatchObject({ ok: true, message: 'Target saved.', href: '/ai-forecast' });
  const removed = await runAction({ id: 't', type: 'set_forecast_target', product: 'gam', amount: 0 });
  expect(removed.message).toBe('Target removed.');
  aiAPI.setForecastTarget.mockRejectedValue(new Error('Admin access required'));
  const bad = await runAction({ id: 't', type: 'set_forecast_target', product: 'gam', amount: 5 });
  expect(bad).toEqual({ ok: false, message: 'Admin access required' });
});

test('open_page navigates to the page, with dates and filters in the link when it has them', async () => {
  const navigate = jest.fn();
  await runAction({ id: 'o', type: 'open_page', href: '/ai-forecast' }, { navigate });
  expect(navigate).toHaveBeenLastCalledWith('/ai-forecast');
  await runAction({ id: 'o', type: 'open_page', product: 'admob', page: 'roi', path: '/admob/roi', presetPage: null }, { navigate });
  expect(navigate).toHaveBeenLastCalledWith('/admob/roi');

  const href = hrefForAction({
    type: 'open_page', product: 'adsense', page: 'reporting', path: '/adsense/reporting', presetPage: 'adsense-reporting',
    startDate: '2026-09-01', endDate: '2026-09-07', snapshot: { sites: ['quiz2.example.com'] },
  });
  expect(href.startsWith('/adsense/reporting?')).toBe(true);
  expect(decodeURIComponent(href)).toContain('quiz2.example.com');
  expect(decodeURIComponent(href)).toContain('2026-09-01');
  // dashboards with no dates or filters are just the path
  expect(hrefForAction({ type: 'open_page', page: 'dashboard', path: '/dashboard', presetPage: 'dashboard', snapshot: {} })).toBe('/dashboard');
});

test('an unknown action does nothing', async () => {
  expect(await runAction({ id: 'x', type: 'delete_everything' })).toEqual({ ok: false, message: 'This action is not supported.' });
});
