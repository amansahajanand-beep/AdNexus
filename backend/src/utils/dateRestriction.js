const { todayInTZ, shiftYMD } = require('./datetime');

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYMD(s) {
  return YMD_RE.test(String(s || '').trim());
}

/** Normalize stored permission → { startDate, endDate } or null. */
function resolveDateRestriction(dr) {
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

function getDateRestriction(user) {
  if (!user || user.role === 'admin') return null;
  return resolveDateRestriction(user.permissions?.dateRestriction);
}

/** Clamp requested report range to the user's allowed window. */
function clampDateRange(startDate, endDate, restriction) {
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

function applyDateRestrictionToFilters(filters = {}, user) {
  const restriction = getDateRestriction(user);
  if (!restriction) return { ...filters };
  const today = todayInTZ();
  const clamped = clampDateRange(
    filters.startDate || today,
    filters.endDate || today,
    restriction
  );
  return { ...filters, ...clamped };
}

/** Build dateRestriction object for DB from admin form values. */
function buildDateRestrictionPayload(startDate, endDate) {
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  if (isValidYMD(start) && isValidYMD(end) && start <= end) {
    return { startDate: start, endDate: end };
  }
  return null;
}

module.exports = {
  isValidYMD,
  resolveDateRestriction,
  getDateRestriction,
  clampDateRange,
  applyDateRestrictionToFilters,
  buildDateRestrictionPayload,
};
