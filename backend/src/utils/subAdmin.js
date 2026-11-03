/**
 * Sub-admin: a domain user with canManageUsers who creates/manages their own domain users,
 * limited to the inventory, networks and permissions they hold themselves.
 */

const {
  FLAG_KEYS,
  isAdmin,
  getUserInventoryScope,
  getAllowedClientIds,
  getAllowedAdsAccountIds,
  assignedSiteMatchesRowHost,
  getAdmobScope,
  getAdsenseScope,
  normalizeAdmobScope,
  normalizeAdsenseScope,
} = require('./permissions');

const norm = (v) => String(v || '').toLowerCase().trim();

function canManageUsers(user) {
  return !isAdmin(user) && user?.permissions?.canManageUsers === true;
}

function isSubAdmin(user) {
  return canManageUsers(user);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function keepIn(values, set) {
  if (!set?.size) return [];
  return asList(values).filter((v) => set.has(norm(v)));
}

/** A site is grantable when listed on the sub-admin, or it sits under one of their domains. */
function keepSites(values, scope) {
  return asList(values).filter((site) => {
    if (scope.sites?.has(norm(site))) return true;
    return [...(scope.domains || [])].some((d) => assignedSiteMatchesRowHost(site, d));
  });
}

/**
 * Narrow a create/update body to what the acting sub-admin may grant. Anything outside
 * their own assignment is dropped; permission flags they lack are forced off.
 */
function clampBodyToActor(actor, body = {}) {
  const scope = getUserInventoryScope(actor) || {};
  const out = { ...body };

  FLAG_KEYS.forEach((k) => {
    if (k === 'canManageUsers') return;
    if (k in out && actor.permissions?.[k] === false) out[k] = false;
  });
  out.canManageUsers = false; // sub-admins cannot create other sub-admins

  if ('allowedDomains' in out) out.allowedDomains = keepIn(out.allowedDomains, scope.domains);
  if ('allowedSites' in out) out.allowedSites = keepSites(out.allowedSites, scope);
  if ('allowedAppIds' in out) out.allowedAppIds = keepIn(out.allowedAppIds, scope.appIds);
  if ('allowedAdUnits' in out) out.allowedAdUnits = keepIn(out.allowedAdUnits, scope.adUnits);

  if ('allowedClientIds' in out) {
    const own = new Set(getAllowedClientIds(actor) || []);
    out.allowedClientIds = asList(out.allowedClientIds).filter((id) => own.has(String(id)));
  }

  const ownAds = getAllowedAdsAccountIds(actor);
  if ('allowedAdsAccountIds' in out && ownAds !== null) {
    const own = new Set(ownAds);
    out.allowedAdsAccountIds = asList(out.allowedAdsAccountIds).filter((id) => own.has(String(id)));
  }

  // AdMob / AdSense scopes: only what the sub-admin holds themselves.
  [['admobScope', 'admob'], ['adsenseScope', 'adsense']].forEach(([field, product]) => {
    if (!(field in out)) return;
    const clamped = clampPublisherScope(actor, product, out[field]);
    if (clamped) out[field] = clamped;
    else delete out[field];
  });

  const actorDays = actor.permissions?.dateRestriction?.maxDaysBack;
  if (actorDays) {
    const asked = parseInt(out.maxDaysBack, 10);
    out.maxDaysBack = Number.isFinite(asked) && asked > 0 ? Math.min(asked, actorDays) : actorDays;
  }
  return out;
}

const PRODUCT_ITEM_KEYS = { admob: ['apps', 'adUnits'], adsense: ['sites'] };

function productScope(actor, product) {
  return product === 'adsense' ? getAdsenseScope(actor) : getAdmobScope(actor);
}

const accountOf = (key) => String(key).split(':')[0];

/** Items ("accountUuid:name") of one kind the sub-admin may grant under an account. */
function grantableItems(actorScope, key, accountId, candidates) {
  const mine = asList(actorScope[key]).filter((k) => accountOf(k) === accountId);
  // Nothing listed under the account = the whole account is theirs.
  if (!mine.length) return candidates;
  const allowed = new Set(mine);
  return candidates.filter((k) => allowed.has(k));
}

/** Narrow an AdMob / AdSense scope a sub-admin is assigning to what the sub-admin holds. */
function clampPublisherScope(actor, product, input) {
  const normalize = product === 'adsense' ? normalizeAdsenseScope : normalizeAdmobScope;
  const asked = normalize(input);
  if (!asked) return null;
  const mine = productScope(actor, product);
  const myAccounts = new Set(mine.accountIds);
  const accountIds = asked.accountIds.filter((id) => myAccounts.has(id));
  const out = { accountIds, filters: asked.filters.filter((f) => asList(mine.filters).includes(f)) };
  for (const key of PRODUCT_ITEM_KEYS[product]) {
    let items = [];
    for (const id of accountIds) {
      const picked = asList(asked[key]).filter((k) => accountOf(k) === id);
      const mineHere = asList(mine[key]).filter((k) => accountOf(k) === id);
      // Nothing picked under an account would grant all of it: hand over only what they hold.
      items = items.concat(grantableItems(mine, key, id, picked.length ? picked : mineHere));
    }
    out[key] = [...new Set(items)];
  }
  for (const k of ['metrics', 'reports']) {
    if (mine[k]) out[k] = (asked[k] || mine[k]).filter((v) => mine[k].includes(v));
    else if (asked[k]) out[k] = asked[k];
  }
  return out;
}

/** Trim an admin scope-catalog response to what the sub-admin holds. */
function scopeProductCatalogForActor(actor, product, catalog) {
  const mine = productScope(actor, product);
  const myAccounts = new Set(mine.accountIds);
  const out = {
    ...catalog,
    accounts: asList(catalog.accounts).filter((a) => myAccounts.has(a.id)),
    filters: asList(catalog.filters).filter((f) => asList(mine.filters).includes(f)),
  };
  for (const key of PRODUCT_ITEM_KEYS[product]) {
    out[key] = asList(catalog[key]).filter((item) => {
      const accountId = accountOf(item.key);
      if (!myAccounts.has(accountId)) return false;
      return grantableItems(mine, key, accountId, [item.key]).length > 0;
    });
  }
  return out;
}

/** Sub-admins only touch domain users they created. */
function ownsUser(actor, target) {
  return !!target
    && target.role !== 'admin'
    && target.id !== actor.id
    && !!target.createdBy
    && target.createdBy === actor.username;
}

/** Trim the inventory-picker response to the sub-admin's own assignment. */
function scopePickerForActor(actor, picker) {
  const scope = getUserInventoryScope(actor) || {};
  const inDomains = (host) => [...(scope.domains || [])].some((d) => assignedSiteMatchesRowHost(host, d));
  const siteOk = (h) => scope.sites?.has(norm(h)) || inDomains(h);
  const domainLabel = (d) => norm(d?.domainName || d?.id || d?.label || d);
  const withOwn = (list, own, key = norm) => {
    const seen = new Set(list.map(key));
    return [...list, ...[...(own || [])].filter((v) => !seen.has(key(v)))];
  };
  // The cached catalog may be empty or stale: always offer what the sub-admin holds.
  const domains = withOwn(
    asList(picker.domains).filter((d) => scope.domains?.has(domainLabel(d))),
    scope.domains,
    domainLabel
  ).map((d) => (typeof d === 'string' ? { id: d, label: d, domainName: d } : d));
  return {
    ...picker,
    siteHosts: withOwn(asList(picker.siteHosts).filter(siteOk), scope.sites),
    appIds: withOwn(asList(picker.appIds).filter((a) => scope.appIds?.has(norm(a))), scope.appIds),
    domainRoots: withOwn(asList(picker.domainRoots).filter((d) => scope.domains?.has(norm(d))), scope.domains),
    domains,
  };
}

module.exports = {
  canManageUsers,
  isSubAdmin,
  clampBodyToActor,
  ownsUser,
  scopePickerForActor,
  clampPublisherScope,
  scopeProductCatalogForActor,
};
