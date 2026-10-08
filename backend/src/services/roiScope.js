/**
 * A domain user's assigned inventory on the ROI page, as exact site hosts and app ids.
 * Assigned domains stand for every site under them (looked up in the network's own site list); assigned sites and apps
 * are used as given. Admins, and users without an assignment, have no restriction (null).
 */
const { query } = require('../db');
const { userHasAssignedInventory } = require('../utils/permissions');

const NONE = '__none__';
const host = (v) => String(v || '').split('»').pop().trim().toLowerCase().replace(/^www\./, '');
const uniq = (list) => [...new Set(list.filter(Boolean))];

async function roiInventoryScope(user, clientId) {
  if (!user || user.role === 'admin' || !userHasAssignedInventory(user)) return null;
  const perms = user.permissions || {};
  const sites = uniq((perms.allowedSites || []).map(host));
  const apps = uniq((perms.allowedAppIds || []).map((a) => String(a || '').trim().toLowerCase()));
  const domains = uniq((perms.allowedDomains || []).map(host));
  if (domains.length && clientId) {
    const { rows } = await query(
      `SELECT DISTINCT LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www[.]', '', 'i'))) AS host
       FROM dim_site ds
       WHERE ds.client_id = $1::uuid AND ds.id > 0 AND NULLIF(TRIM(ds.name), '') IS NOT NULL
         AND (LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www[.]', '', 'i'))) = ANY($2::text[])
           OR SUBSTRING(LOWER(TRIM(REGEXP_REPLACE(ds.name, '^www[.]', '', 'i'))) FROM '[^.]+[.][^.]+$') = ANY($2::text[]))`,
      [clientId, domains]
    );
    sites.push(...rows.map((r) => r.host));
  }
  return { sites: uniq(sites), apps };
}

/** Request keys limited to the scope: nothing asked for = the whole scope; an empty side = none of that kind. */
function limitKeys(requested, allowed, normalise = (v) => v) {
  if (!allowed.length) return [NONE];
  if (!requested.length) return allowed;
  const ok = new Set(allowed);
  const kept = requested.filter((k) => ok.has(normalise(k)));
  return kept.length ? kept : [NONE];
}

module.exports = { roiInventoryScope, limitKeys, NONE };
