/* ROI sheets: one per Ads account, stored on the synced 'roi-sheets' presets page. */
jest.mock('../api', () => ({
  presetsAPI: { getAll: jest.fn(), savePage: jest.fn().mockResolvedValue({ version: 1, items: [] }) },
}));

import {
  addRoiSheet, findRoiSheetByAccount, listRoiSheets, removeRoiSheet, sheetAccountId, sheetName,
} from './roiSheets';
import { PRESET_PAGES } from './reportPresets';

const U = 'admin-1';

beforeEach(() => localStorage.clear());

test('a sheet is stored on the roi-sheets page, named after the Ads account', () => {
  expect(PRESET_PAGES.roiSheets).toBe('roi-sheets');
  const sheet = addRoiSheet({ id: 'acc-1', label: 'Vam#02 281' }, U);
  // '#' is not allowed in a saved-preset name, so the real name is kept in the snapshot
  expect(sheetName(sheet)).toBe('Vam#02 281');
  expect(sheetAccountId(sheet)).toBe('acc-1');
  expect(listRoiSheets(U)).toHaveLength(1);
});

test('adding the same account twice keeps one sheet', () => {
  const a = addRoiSheet({ id: 'acc-1', label: 'Vam' }, U);
  const b = addRoiSheet({ id: 'acc-1', label: 'Vam' }, U);
  expect(b.id).toBe(a.id);
  expect(listRoiSheets(U)).toHaveLength(1);
});

test('each account gets its own sheet and sheets are per user', () => {
  addRoiSheet({ id: 'acc-1', label: 'One' }, U);
  addRoiSheet({ id: 'acc-2', label: 'Two' }, U);
  expect(listRoiSheets(U).map(sheetName).sort()).toEqual(['One', 'Two']);
  expect(listRoiSheets('someone-else')).toHaveLength(0);
  expect(sheetName(findRoiSheetByAccount('acc-2', U))).toBe('Two');
});

test('remove', () => {
  const s = addRoiSheet({ id: 'acc-1', label: 'One' }, U);
  removeRoiSheet(s.id, U);
  expect(listRoiSheets(U)).toHaveLength(0);
});

test('a long account name is shortened to the preset name limit', () => {
  const long = 'A very long Google Ads account name that goes past forty chars';
  const s = addRoiSheet({ id: 'acc-9', label: long }, U);
  expect(s.name.length).toBeLessThanOrEqual(40);
  expect(sheetName(s)).toBe(long); // the sidebar and sheet page still show the full name
});
