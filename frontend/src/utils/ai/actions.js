import { aiAPI } from '../api';
import {
  PRESET_PAGES,
  getReportPresets,
  hrefForPreset,
  saveReportPreset,
} from '../report/reportPresets';

/*
 * What the chat's action cards do when the user clicks them. The chat only proposes; these run through the same
 * code the pages use (the presets store, the forecast target call, plain navigation).
 */

const PRESET_LIMIT = 50;
const PRESETS_PAGE = { gam: '/presets', admob: '/admob/presets', adsense: '/adsense/presets' };

/** Where "Open" goes: the page itself, with the date range and filters applied when the page supports them. */
export function hrefForAction(action) {
  if (action.href) return action.href;
  const pageKey = Object.values(PRESET_PAGES).includes(action.presetPage) ? action.presetPage : null;
  const hasState = action.startDate || Object.keys(action.snapshot || {}).length;
  if (pageKey && hasState) {
    return hrefForPreset(pageKey, { ...(action.snapshot || {}), ...(action.startDate ? { startDate: action.startDate, endDate: action.endDate } : {}) });
  }
  return action.path || '/dashboard';
}

/**
 * Run a confirmed action.
 * @returns {{ok: boolean, message: string, href?: string, linkLabel?: string}}
 */
export async function runAction(action, { navigate, userId } = {}) {
  if (action.type === 'open_page') {
    navigate?.(hrefForAction(action));
    return { ok: true, message: 'Opened.' };
  }

  if (action.type === 'save_preset') {
    const existing = getReportPresets(action.presetPage, userId);
    if (existing.some((p) => p.name.toLowerCase() === action.name.toLowerCase())) {
      return { ok: false, message: `A preset named "${action.name}" already exists on that page. Ask for a different name.` };
    }
    if (existing.length >= PRESET_LIMIT) {
      return { ok: false, message: `That page already has the maximum of ${PRESET_LIMIT} presets. Delete one first.` };
    }
    const next = saveReportPreset(action.presetPage, action.name, action.snapshot || {}, userId);
    // saveReportPreset hands back the old list when it refuses a name, so check the preset really is there.
    if (!next.some((p) => p.name === action.name)) {
      return { ok: false, message: 'The preset could not be saved. Check the name and try again.' };
    }
    return { ok: true, message: `Saved "${action.name}".`, href: PRESETS_PAGE[action.product] || '/presets', linkLabel: 'View presets' };
  }

  if (action.type === 'set_forecast_target') {
    try {
      await aiAPI.setForecastTarget(action.product, action.amount);
    } catch (err) {
      return { ok: false, message: err?.message || 'Could not save the target.' };
    }
    return { ok: true, message: action.amount > 0 ? 'Target saved.' : 'Target removed.', href: '/ai-forecast', linkLabel: 'Open Forecast' };
  }

  return { ok: false, message: 'This action is not supported.' };
}
