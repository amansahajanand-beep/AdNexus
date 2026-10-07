/**
 * Which timezone an AI request is about.
 *
 * The app lets a user view a Google Ad Manager network in another timezone (X-Report-Tz header). The AI services must
 * read the same days the user is looking at, so the header is validated here once and carried on the request context:
 *   viewTz     the chosen zone when it differs from the network's own (null otherwise: nothing to regroup)
 *   networkTz  the timezone Ad Manager reports this network in
 *   dayTz      the zone whose calendar decides "today", "yesterday" and "this month" (viewTz, else networkTz)
 */
const { getNetworkTz, isValidTz } = require('../services/networkTimezone');

async function resolveViewTz(req) {
  const client = req.client || null;
  const networkTz = await getNetworkTz(client);
  const header = String(req.headers?.['x-report-tz'] || '').trim();
  const viewTz = header && isValidTz(header) && header !== networkTz ? header : null;
  return { viewTz, networkTz, dayTz: viewTz || networkTz };
}

/** Headers that make an in-process data call return days in the viewer's zone. */
const tzHeaders = (ctx) => (ctx?.viewTz ? { 'x-report-tz': ctx.viewTz } : {});

module.exports = { resolveViewTz, tzHeaders };
