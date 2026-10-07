/**
 * The timezone the user is viewing Google Ad Manager data in. Empty means the network's own timezone.
 *
 * One choice for the whole app, kept in this browser: the Dashboard, Reporting, Presets and every AI request read it,
 * so a page and the AI always talk about the same days. The backend regroups the stored hourly data into this
 * timezone's days; it is sent as the X-Report-Tz header (see utils/api.js and utils/ai/eventStream.js).
 */
const KEY = 'adnexus.report.tz';
const LEGACY_KEY = 'adnexus.dashboard.tz'; // before the choice was shared with the other pages

function read() {
  try {
    return window.localStorage.getItem(KEY) || window.localStorage.getItem(LEGACY_KEY) || '';
  } catch {
    return '';
  }
}

let current = read();
const listeners = new Set();

export function getReportTz() {
  return current;
}

export function setReportTz(tz) {
  const next = String(tz || '');
  if (next === current) return;
  current = next;
  try {
    if (next) window.localStorage.setItem(KEY, next);
    else window.localStorage.removeItem(KEY);
    window.localStorage.removeItem(LEGACY_KEY);
  } catch { /* storage unavailable: the choice lasts until the page is reloaded */ }
  listeners.forEach((fn) => fn(next));
}

/** Calls fn(tz) whenever the choice changes (including from another component). Returns an unsubscribe function. */
export function subscribeReportTz(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Headers that make a request return days in the chosen timezone ({} when the network's own is in use). */
export function reportTzHeaders() {
  return current ? { 'X-Report-Tz': current } : {};
}
