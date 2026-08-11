/**
 * Single source of truth for the Google Ad Manager SOAP API version.
 *
 * Set GAM_API_VERSION in .env (format: vYYYYMM, e.g. v202602). Every service
 * call reads it from here, so upgrading the API version is a one-line change
 * in .env instead of editing 6 files.
 *
 * GAM ships a new version every quarter and each version lives ~1 year:
 *   - deprecation (warning)  = release month + 9 months
 *   - sunset (stops working) = release month + 12 months
 * After sunset, every SOAP request fails. This module computes that status so
 * the UI can warn the admin to update the version *before* it breaks — without
 * disrupting normal usage.
 */

const GAM_API_VERSION = process.env.GAM_API_VERSION || 'v202602';

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function monthName(date) {
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Returns the deprecation status of the configured API version.
 * status: 'ok' | 'approaching' | 'deprecated' | 'sunset' | 'unknown'
 */
function getVersionStatus(now = new Date()) {
  const m = /^v(\d{4})(\d{2})$/.exec(GAM_API_VERSION);
  if (!m) {
    return { version: GAM_API_VERSION, status: 'unknown' };
  }

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10); // 1-12
  const release = new Date(Date.UTC(year, month - 1, 1));
  const approaching = addMonths(release, 7);  // soft heads-up
  const deprecation = addMonths(release, 9);  // Google's deprecation month
  const sunset = addMonths(release, 12);       // Google's sunset month

  let status = 'ok';
  if (now >= sunset) status = 'sunset';
  else if (now >= deprecation) status = 'deprecated';
  else if (now >= approaching) status = 'approaching';

  return {
    version: GAM_API_VERSION,
    status,
    deprecationDate: monthName(deprecation),
    sunsetDate: monthName(sunset),
  };
}

module.exports = { GAM_API_VERSION, getVersionStatus };
