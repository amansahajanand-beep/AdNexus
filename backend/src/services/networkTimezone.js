/**
 * The timezone a Google Ad Manager network reports in. Ad Manager cuts its report days and hours in the network's own
 * timezone, so anything that regroups hours into another timezone's days must start from this one, per network.
 *
 * Read once from Ad Manager (NetworkService.getCurrentNetwork), stored on gam_clients.time_zone, and cached.
 * When it cannot be read (offline, mock network, no credentials) the app-wide APP_TIMEZONE is used, which is what
 * the whole app assumed before this existed.
 */
const axios = require('axios');
const { query } = require('../db');
const logger = require('../utils/logger');
const { APP_TIMEZONE } = require('../utils/datetime');
const { runWithClient } = require('../utils/clientContext');

const known = new Map(); // client id -> IANA zone
const inflight = new Map();

function isValidTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Ad Manager's own getCurrentNetwork call for one network, as that network's admin. */
async function fetchFromGam(client) {
  const { getGAMClient } = require('../gam/client');
  const { GAM_API_VERSION } = require('../utils/gamVersion');
  return runWithClient(client, async () => {
    const auth = await getGAMClient();
    const token = (await auth.getAccessToken()).token;
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${GAM_API_VERSION}">
  <soapenv:Header><dfp:RequestHeader>
    <dfp:networkCode>${client.networkCode}</dfp:networkCode>
    <dfp:applicationName>AdNexus</dfp:applicationName>
  </dfp:RequestHeader></soapenv:Header>
  <soapenv:Body><dfp:getCurrentNetwork/></soapenv:Body>
</soapenv:Envelope>`;
    const res = await axios.post(
      `https://ads.google.com/apis/ads/publisher/${GAM_API_VERSION}/NetworkService`,
      envelope,
      { headers: { 'Content-Type': 'text/xml; charset=UTF-8', Authorization: `Bearer ${token}` }, timeout: 20000 }
    );
    const m = String(res.data || '').match(/<(?:[^:>]+:)?timeZone[^>]*>([^<]+)<\/(?:[^:>]+:)?timeZone>/);
    return m ? m[1].trim() : null;
  });
}

async function resolveAndStore(client) {
  const tz = await fetchFromGam(client);
  if (!isValidTz(tz)) throw new Error(`Ad Manager returned an unusable timezone (${tz})`);
  await query('UPDATE gam_clients SET time_zone = $2 WHERE id = $1::uuid', [client.id, tz]);
  return tz;
}

/**
 * The network's IANA timezone. Never throws: falls back to APP_TIMEZONE and tries again on a later call.
 * @param {{id?: string, networkCode?: string, timeZone?: string|null, refreshToken?: string}} client
 */
async function getNetworkTz(client) {
  if (!client?.id) return APP_TIMEZONE;
  if (isValidTz(client.timeZone)) return client.timeZone;
  if (known.has(client.id)) return known.get(client.id);
  if (!client.refreshToken || !client.networkCode) return APP_TIMEZONE; // mock or unfinished network
  if (!inflight.has(client.id)) {
    inflight.set(client.id, resolveAndStore(client)
      .then((tz) => { known.set(client.id, tz); client.timeZone = tz; return tz; })
      .catch((err) => {
        logger.warn(`Network timezone lookup failed for ${String(client.id).slice(0, 8)}: ${err.message}`);
        return null;
      })
      .finally(() => inflight.delete(client.id)));
  }
  return (await inflight.get(client.id)) || APP_TIMEZONE;
}

module.exports = { getNetworkTz, isValidTz };
