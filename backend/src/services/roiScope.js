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

/** App ids the given Ads accounts advertise (spend rows in the range, plus their campaign maps). */
async function appsOfAccounts(accountIds, start, end) {
  const { rows } = await query(
    `SELECT LOWER(TRIM(s.app_id)) AS app
     FROM ads_spend_daily s
     WHERE s.report_date BETWEEN $1::date AND $2::date
       AND s.ads_account_id = ANY($3::uuid[]) AND NULLIF(TRIM(s.app_id), '') IS NOT NULL
     GROUP BY 1
     UNION
     SELECT LOWER(TRIM(m.target_key))
     FROM ads_campaign_map m
     WHERE m.target_type = 'app'
       AND m.ads_account_id = ANY($3::uuid[]) AND NULLIF(TRIM(m.target_key), '') IS NOT NULL`,
    [start, end, accountIds]
  );
  // Not limited to one network: the account's spend is in one network, its app's revenue may be in another.
  return new Set(rows.map((r) => r.app).filter(Boolean));
}

module.exports = { roiInventoryScope, limitKeys, appsOfAccounts, NONE };
