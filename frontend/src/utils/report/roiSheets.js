import { useCallback, useEffect, useState } from 'react';
import {
  PRESET_NAME_MAX,
  PRESET_PAGES,
  PRESETS_CHANGED_EVENT,
  getReportPresets,
  removeReportPreset,
  saveReportPreset,
} from './reportPresets';

/**
 * ROI "sheets": an admin adds one per Ads account; each shows in the sidebar under ROI and opens that account's
 * ROI with a day / week / month / year table. A sheet is stored as an entry of the synced presets page
 * 'roi-sheets' (name = Ads account name, snapshot.accountIds = [that account]), so it follows the admin across
 * browsers like any saved preset.
 */
const PAGE = PRESET_PAGES.roiSheets;

export const sheetAccountId = (sheet) => String(sheet?.snapshot?.accountIds?.[0] || '');

/**
 * The Ads account's real name. Saved-preset names only allow letters, digits, spaces and . _ , & ' ( ) + - and at
 * most 40 characters (an account called "Vam#02 281" would be refused), so the exact name travels in the snapshot and
 * the preset name is only a cleaned-up fallback.
 */
export const sheetName = (sheet) => String(sheet?.snapshot?.accountLabels?.[0] || sheet?.name || '').trim() || 'Ads account';

const storageName = (label) => (
  String(label || '').replace(/[^\p{L}\p{N}\s._,&'()+-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX).trim()
  || 'Ads account'
);

export function listRoiSheets(userId) {
  return getReportPresets(PAGE, userId).filter((s) => sheetAccountId(s));
}

export function findRoiSheetByAccount(accountId, userId) {
  const id = String(accountId || '');
  return listRoiSheets(userId).find((s) => sheetAccountId(s) === id) || null;
}

/** Add a sheet for the account (one per account); returns the sheet, new or existing. */
export function addRoiSheet({ id, label }, userId) {
  const accountId = String(id || '');
  if (!accountId) return null;
  const existing = findRoiSheetByAccount(accountId, userId);
  if (existing) return existing;
  const fullName = String(label || accountId).trim();
  saveReportPreset(PAGE, storageName(fullName), { accountIds: [accountId], accountLabels: [fullName] }, userId);
  return findRoiSheetByAccount(accountId, userId);
}

export function removeRoiSheet(sheetId, userId) {
  return removeReportPreset(PAGE, sheetId, userId);
}

/** The signed-in user's sheets, kept in step with adds / removes / server syncs. */
export function useRoiSheets(userId) {
  const read = useCallback(() => (userId ? listRoiSheets(userId) : []), [userId]);
  const [sheets, setSheets] = useState(read);
  useEffect(() => {
    const refresh = () => setSheets(read());
    refresh();
    window.addEventListener(PRESETS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PRESETS_CHANGED_EVENT, refresh);
  }, [read]);
  return sheets;
}
