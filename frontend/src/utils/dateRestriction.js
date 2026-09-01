import { presetRange, shiftYMD, todayInTZ } from './datetime';
import { isAdmin } from './auth/permissions';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYMD(s) {
  return YMD_RE.test(String(s || '').trim());
}

/** Normalize permission → { startDate, endDate } or null. */
export function resolveDateRestriction(dr) {
  if (!dr || typeof dr !== 'object') return null;
  const start = String(dr.startDate || '').trim();
  const end = String(dr.endDate || '').trim();
  if (isValidYMD(start) && isValidYMD(end) && start <= end) {
    return { startDate: start, endDate: end };
  }
  const days = parseInt(dr.maxDaysBack, 10);
  if (Number.isFinite(days) && days > 0) {
    const today = todayInTZ();
    return { startDate: shiftYMD(today, -(days - 1)), endDate: today };
  }
  return null;
}

export function getDateRestriction(user) {
  if (isAdmin(user)) return null;
  return resolveDateRestriction(user?.permissions?.dateRestriction);
}

export function clampDateRange(startDate, endDate, restriction) {
  if (!restriction?.startDate || !restriction?.endDate) {
    return { startDate, endDate };
  }
  let sd = String(startDate || restriction.startDate).trim();
  let ed = String(endDate || restriction.endDate).trim();
  if (!isValidYMD(sd)) sd = restriction.startDate;
  if (!isValidYMD(ed)) ed = restriction.endDate;
  if (sd < restriction.startDate) sd = restriction.startDate;
  if (ed > restriction.endDate) ed = restriction.endDate;
  if (sd > ed) {
    if (ed >= restriction.startDate) sd = ed;
    else {
      sd = restriction.startDate;
      ed = restriction.endDate;
    }
  }
  return { startDate: sd, endDate: ed };
}

/** Default report range respecting assigned window. */
export function defaultReportRangeForUser(user) {
  const restriction = getDateRestriction(user);
  const today = presetRange('today');
  if (!restriction) return today;
  return clampDateRange(today.startDate, today.endDate, restriction);
}

/** Clamp a preset range to an assigned date window. */
export function clampPresetRange(presetId, restriction) {
  const r = presetRange(presetId);
  if (!restriction) return r;
  return clampDateRange(r.startDate, r.endDate, restriction);
}

/** Initial/saved report dates for a user. */
export function initialReportDatesForUser(user, saved) {
  const restriction = getDateRestriction(user);
  if (saved?.startDate && saved?.endDate) {
    return clampDateRange(saved.startDate, saved.endDate, restriction);
  }
  return defaultReportRangeForUser(user);
}

export function formatDateRestrictionLabel(restriction) {
  if (!restriction) return '';
  if (restriction.startDate === restriction.endDate) return restriction.startDate;
  return `${restriction.startDate} → ${restriction.endDate}`;
}

/** True when a preset's natural range fits entirely inside the assigned window. */
export function isPresetAllowedForRestriction(presetId, restriction) {
  if (!restriction) return true;
  if (presetId === 'custom') return true;
  const r = presetRange(presetId);
  return r.startDate >= restriction.startDate && r.endDate <= restriction.endDate;
}

/** Filter preset list to only options the user may pick. */
export function allowedDatePresets(restriction, presets) {
  if (!restriction) return presets;
  return presets.filter((p) => isPresetAllowedForRestriction(p.id, restriction));
}

/** Clamp a single YMD to the assigned window. */
export function clampDateValue(ymd, restriction) {
  if (!restriction?.startDate || !restriction?.endDate || !isValidYMD(ymd)) return ymd;
  let v = String(ymd).trim();
  if (v < restriction.startDate) v = restriction.startDate;
  if (v > restriction.endDate) v = restriction.endDate;
  return v;
}

/** True when user is locked to a single calendar day. */
export function isFixedDateRestriction(restriction) {
  return Boolean(
    restriction?.startDate
    && restriction?.endDate
    && restriction.startDate === restriction.endDate
  );
}
/** True when custom range is selected but start/end are not both set. */
export function isCustomRangeIncomplete(preset, startDate, endDate) {
  if (preset !== 'custom') return false;
  return !isValidYMD(startDate) || !isValidYMD(endDate);
}

/** Dates that should drive API calls — custom draft dates are excluded until Apply. */
export function committedReportDates({
  preset,
  filterApplied,
  applied,
  startDate,
  endDate,
  fallback,
}) {
  if (preset === 'custom') {
    if (filterApplied && isValidYMD(applied?.startDate) && isValidYMD(applied?.endDate)) {
      return { startDate: applied.startDate, endDate: applied.endDate };
    }
    return fallback;
  }
  if (filterApplied) {
    return {
      startDate: applied?.startDate || startDate,
      endDate: applied?.endDate || endDate,
    };
  }
  return { startDate, endDate };
}

/** Admin quick-assign: last N calendar days ending today (N >= 1). */
export function adminQuickDateRange(days) {
  const n = Math.max(1, parseInt(days, 10) || 1);
  const today = todayInTZ();
  return { start: shiftYMD(today, -(n - 1)), end: today };
}
