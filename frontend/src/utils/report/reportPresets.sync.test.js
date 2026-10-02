/* Server preset sync: debounced push, offline retry, first-sync migration, conflict merge. */
jest.mock('../api', () => ({
  presetsAPI: { getAll: jest.fn(), savePage: jest.fn() },
}));

import { presetsAPI } from '../api';
import {
  PRESET_PAGES, saveReportPreset, getReportPresets, removeReportPreset, syncPresetsFromServer,
} from './reportPresets';

const U = 'user-1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const srvItem = (id, name, when) => ({ id, name, snapshot: { apps: ['A'] }, summary: '', when, pinned: false, pinnedAt: null });

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

test('saving pushes to the server (debounced) and records the version', async () => {
  presetsAPI.savePage.mockResolvedValue({ version: 1, items: [] });
  saveReportPreset(PRESET_PAGES.admob, 'first', { apps: ['A'] }, U);
  saveReportPreset(PRESET_PAGES.admob, 'second', { apps: ['B'] }, U);
  expect(presetsAPI.savePage).not.toHaveBeenCalled();
  await wait(700);
  expect(presetsAPI.savePage).toHaveBeenCalledTimes(1);
  const [page, items, base] = presetsAPI.savePage.mock.calls[0];
  expect(page).toBe('admob');
  expect(items).toHaveLength(2);
  expect(base).toBe(0);
  expect(localStorage.getItem(`reportPresets_v1:admob:${U}:v`)).toBe('1');
  expect(localStorage.getItem(`reportPresets_v1:admob:${U}:dirty`)).toBeNull();
});

test('offline save stays dirty and uploads on next sync', async () => {
  presetsAPI.savePage.mockRejectedValueOnce(new Error('offline'));
  saveReportPreset(PRESET_PAGES.roi, 'offline one', {}, U);
  await wait(700);
  expect(localStorage.getItem(`reportPresets_v1:roi:${U}:dirty`)).toBe('1');
  presetsAPI.getAll.mockResolvedValue({ pages: {} });
  presetsAPI.savePage.mockResolvedValue({ version: 1, items: [] });
  await syncPresetsFromServer(U);
  expect(presetsAPI.savePage).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem(`reportPresets_v1:roi:${U}:dirty`)).toBeNull();
});

test('first sync uploads pre-existing local presets (migration)', async () => {
  localStorage.setItem(`reportPresets_v1:dashboard:${U}`, JSON.stringify([srvItem('l1', 'old local', 5)]));
  presetsAPI.getAll.mockResolvedValue({ pages: {} });
  presetsAPI.savePage.mockResolvedValue({ version: 1, items: [] });
  await syncPresetsFromServer(U);
  expect(presetsAPI.savePage).toHaveBeenCalledWith('dashboard', expect.any(Array), 0);
  expect(presetsAPI.savePage.mock.calls[0][1][0].id).toBe('l1');
});

test('sync adopts a newer server copy when nothing is pending', async () => {
  presetsAPI.getAll.mockResolvedValue({
    pages: { admob: { version: 4, items: [srvItem('s1', 'from phone', 10)] } },
  });
  await syncPresetsFromServer(U);
  expect(getReportPresets(PRESET_PAGES.admob, U).map((p) => p.name)).toEqual(['from phone']);
  expect(localStorage.getItem(`reportPresets_v1:admob:${U}:v`)).toBe('4');
});

test('409 conflict merges by id and retries with the server version', async () => {
  localStorage.setItem(`reportPresets_v1:adsense:${U}`, JSON.stringify([srvItem('a', 'mine', 20)]));
  localStorage.setItem(`reportPresets_v1:adsense:${U}:v`, '2');
  presetsAPI.savePage
    .mockResolvedValueOnce({ error: 'Presets changed elsewhere', version: 3, items: [srvItem('b', 'theirs', 15), srvItem('a', 'older a', 5)] })
    .mockResolvedValueOnce({ version: 4, items: [] });
  presetsAPI.getAll.mockResolvedValue({ pages: { adsense: { version: 3, items: [srvItem('b', 'theirs', 15), srvItem('a', 'older a', 5)] } } });
  // mark dirty so sync pushes
  localStorage.setItem(`reportPresets_v1:adsense:${U}:dirty`, '1');
  await syncPresetsFromServer(U);
  const names = getReportPresets(PRESET_PAGES.adsense, U).map((p) => p.name).sort();
  expect(names).toEqual(['mine', 'theirs']);
  const last = presetsAPI.savePage.mock.calls.at(-1);
  expect(last[2]).toBe(3);
  expect(localStorage.getItem(`reportPresets_v1:adsense:${U}:v`)).toBe('4');
});

test('delete pushes the shorter list', async () => {
  presetsAPI.savePage.mockResolvedValue({ version: 1, items: [] });
  const list = saveReportPreset(PRESET_PAGES.admobRoi, 'to delete', {}, U);
  await wait(700);
  removeReportPreset(PRESET_PAGES.admobRoi, list[0].id, U);
  await wait(700);
  expect(presetsAPI.savePage.mock.calls.at(-1)[1]).toHaveLength(0);
});
