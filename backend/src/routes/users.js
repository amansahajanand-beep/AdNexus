/**

 * Admin user-management routes. Mounted at /api/users.

 */

const express = require('express');

const router = express.Router();

const { requireAdmin } = require('../middleware/auth');

const {

  getUsersByClientId,

  getUsersByClientIds,

  getUserById,

  createUser,

  updateUser,

  deleteUser,

  toAdminSafeUser,

} = require('../models/userStore');

const {

  getAccountIdForClient,

  listClientsByAccountId,

} = require('../models/clientStore');

const logger = require('../utils/logger');

const { validatePassword } = require('../utils/passwordPolicy');
const { validateUsername, validateSavedName } = require('../utils/namePolicy');

const { normalizePermissions, FLAG_KEYS, INVENTORY_SCOPE_KEYS } = require('../utils/permissions');
const { cache } = require('../gam/client');
const {
  findCachedInventoryRows,
  buildCatalogFilterOptions,
  rowsToDomainOptions,
  catalogCacheKey,
} = require('../utils/inventoryCatalog');
const { appPackageForPicker, isLikelyAppPackage } = require('../utils/appIdentity');



function collectFlags(body = {}) {

  const flags = {};

  FLAG_KEYS.forEach((k) => { if (typeof body[k] === 'boolean') flags[k] = body[k]; });

  return flags;

}



function mergeInventoryFromBody(merged, body = {}) {
  INVENTORY_SCOPE_KEYS.forEach((k) => {
    if (Array.isArray(body[k])) merged[k] = body[k];
  });
  return merged;
}

function permissionsTouched(body = {}) {
  return FLAG_KEYS.some((k) => k in body)
    || INVENTORY_SCOPE_KEYS.some((k) => k in body)
    || 'maxDaysBack' in body;
}

function buildFromBody(role, body = {}) {
  const inventory = {};
  INVENTORY_SCOPE_KEYS.forEach((k) => {
    if (Array.isArray(body[k])) inventory[k] = body[k];
  });
  const maxDays = body.maxDaysBack != null ? parseInt(body.maxDaysBack, 10) : undefined;
  const dateRestriction = Number.isFinite(maxDays) && maxDays > 0 ? { maxDaysBack: maxDays } : null;
  return normalizePermissions(role, {
    ...collectFlags(body),
    ...inventory,
    dateRestriction,
  });
}

function mergePermissionsFromBody(existingPerms, body = {}) {
  const merged = { ...(existingPerms || {}), ...collectFlags(body) };
  mergeInventoryFromBody(merged, body);
  if ('maxDaysBack' in body) {
    const days = parseInt(body.maxDaysBack, 10);
    merged.dateRestriction = Number.isFinite(days) && days > 0 ? { maxDaysBack: days } : null;
  }
  return normalizePermissions('child', merged);
}


router.use(requireAdmin);



router.get('/inventory-picker', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Vary', 'Authorization');
  const cached = cache.get(catalogCacheKey());
  const rows = cached?.rows?.length
    ? cached.rows
    : (findCachedInventoryRows(cache) || []);
  const filterOpts = buildCatalogFilterOptions(rows, {
    siteHosts: cached?.rawHosts?.siteHosts || [],
    sitesByDomain: cached?.rawHosts?.sitesByDomain || {},
    domainRoots: cached?.rawHosts?.domainRoots || [],
  });
  const appIdSeen = new Set();
  const appIds = [];
  const addPkg = (pkg) => {
    const id = String(pkg || '').trim();
    if (!id || id === '—' || !isLikelyAppPackage(id)) return;
    const key = id.toLowerCase();
    if (appIdSeen.has(key)) return;
    appIdSeen.add(key);
    appIds.push(id);
  };
  (cached?.appPackages || []).forEach(addPkg);
  if (!appIds.length) {
    rows.forEach((r) => {
      const pkg = appPackageForPicker(r);
      if (pkg) addPkg(pkg);
    });
  }
  appIds.sort((a, b) => a.localeCompare(b));
  res.json({
    siteHosts: filterOpts.siteHosts || [],
    appIds,
    domainRoots: filterOpts.domainRoots || [],
    domains: rowsToDomainOptions(rows),
    hasCatalog: rows.length > 0,
  });
});


router.get('/permissions/catalog', (req, res) => {

  res.json({

    pages: [

      { key: 'canAccessDashboard', label: 'Dashboard', hint: 'Summary cards & detailed report' },

      { key: 'canAccessReporting', label: 'Reporting', hint: 'Full reports & CSV export' },

      { key: 'canAccessDomainUser', label: 'Domain User', hint: 'Per-domain earnings view' },

    ],

    actions: [

      { key: 'canLogin', label: 'Log in', hint: 'Allow user to sign in' },

      { key: 'canGenerateReports', label: 'View reports', hint: 'Load live report data' },

      { key: 'canDownloadReports', label: 'Download CSV', hint: 'Export report files' },

      { key: 'canUseFilters', label: 'Apply filters', hint: 'Date, country, domain, site filters' },

      { key: 'canUseReportBuilder', label: 'Report builder', hint: 'Dimensions & metrics panel' },

    ],

    metrics: [

      { key: 'canSeeRevenue', label: 'Revenue & earnings' },

      { key: 'canSeeImpressions', label: 'Impressions' },

      { key: 'canSeeCTR', label: 'CTR & clicks' },

      { key: 'canSeeECPM', label: 'eCPM & fill rate' },

      { key: 'canSeeProgrammatic', label: 'Programmatic channel report' },

    ],

  });

});



async function accountNetworksFor(req) {
  const accountId = await getAccountIdForClient(req.client?.id || req.user?.clientId);
  const networks = await listClientsByAccountId(accountId);
  return (networks || []).filter((n) => !n.isPending);
}

/** Resolve allowed network UUIDs from body; must belong to this account. */
function resolveAllowedClientIds(body, networks, fallbackId) {
  const networkIds = new Set((networks || []).map((n) => n.id));
  const raw = body?.allowedClientIds;
  let ids = [];
  if (Array.isArray(raw)) {
    ids = raw.map((id) => String(id || '').trim()).filter((id) => networkIds.has(id));
  }
  if (!ids.length) {
    const single = String(body?.clientId || '').trim();
    if (single && networkIds.has(single)) ids = [single];
  }
  if (!ids.length && fallbackId && networkIds.has(fallbackId)) {
    ids = [fallbackId];
  } else if (!ids.length && fallbackId) {
    ids = [fallbackId];
  }
  return [...new Set(ids)];
}

async function assertSameAccount(req, user) {
  if (!user?.clientId) return false;
  const networks = await accountNetworksFor(req);
  return networks.some((n) => n.id === user.clientId);
}

router.get('/', async (req, res) => {
  try {
    const networks = await accountNetworksFor(req);
    const ids = networks.map((n) => n.id);
    const fallbackId = req.user.clientId || req.client?.id;
    const users = ids.length
      ? await getUsersByClientIds(ids)
      : await getUsersByClientId(fallbackId);
    const byId = Object.fromEntries(networks.map((n) => [n.id, n]));
    res.json(users.map((u) => {
      const net = byId[u.clientId];
      const allowedRaw = u.permissions?.allowedClientIds;
      const allowedIds = Array.isArray(allowedRaw) && allowedRaw.length
        ? [...new Set(allowedRaw.map((id) => String(id || '').trim()).filter(Boolean))]
        : (u.clientId ? [u.clientId] : []);
      const networkNames = allowedIds
        .map((id) => byId[id]?.name || byId[id]?.networkCode)
        .filter(Boolean);
      return {
        ...u,
        networkName: networkNames.length
          ? networkNames.join(', ')
          : (net?.name || null),
        networkCode: net?.networkCode || null,
        allowedClientIds: allowedIds,
        networkNames,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/', async (req, res) => {

  const { username, password, email, role } = req.body || {};

  if (!username || !password) {

    return res.status(400).json({ error: 'Username and password are required.' });

  }

  const nameCheck = validateUsername(username);
  if (!nameCheck.valid) {
    return res.status(400).json({ error: nameCheck.errors[0] });
  }

  const pwCheck = validatePassword(password, { username: username.trim() });

  if (!pwCheck.valid) {

    return res.status(400).json({ error: pwCheck.errors[0] });

  }

  const userRole = role === 'admin' ? 'admin' : 'child';

  try {
    const networks = await accountNetworksFor(req);
    const fallbackId = req.user.clientId || req.client?.id;
    const allowedIds = userRole === 'admin'
      ? []
      : resolveAllowedClientIds(req.body, networks, fallbackId);
    const primaryClientId = allowedIds[0] || fallbackId;

    const bodyForPerms = userRole === 'admin'
      ? req.body
      : { ...req.body, allowedClientIds: allowedIds };

    const user = await createUser({
      username: username.trim(),
      email: email || `${username.trim()}@local`,
      password,
      role: userRole,
      permissions: buildFromBody(userRole, bodyForPerms),
      createdBy: req.user.username,
      clientId: primaryClientId,
    });

    logger.info(`User created: ${user.username} by ${req.user.username}`);

    res.status(201).json(user);

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



router.put('/:id', async (req, res) => {

  const { username, password, email, role, isActive } = req.body || {};

  const existing = await getUserById(req.params.id);

  if (!existing || !await assertSameAccount(req, existing)) return res.status(404).json({ error: 'User not found' });



  const updates = {};

  if (username) {
    const nameCheck = validateUsername(username);
    if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.errors[0] });
    updates.username = username.trim();
  }

  if (email) updates.email = email;

  if (password) {

    const pwCheck = validatePassword(password, { username: username?.trim() || existing.username });

    if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.errors[0] });

    updates.password = password;

  }

  if (typeof isActive === 'boolean') updates.isActive = isActive;



  const nextRole = role === 'admin' ? 'admin' : role === 'child' ? 'child' : existing.role;

  if (existing.role === 'admin' && nextRole !== 'admin') {
    return res.status(400).json({ error: 'Admin role cannot be changed to Domain User.' });
  }

  if (role) updates.role = nextRole;



  const permsTouched = permissionsTouched(req.body || {});
  const networksTouched = Array.isArray(req.body?.allowedClientIds) || ('clientId' in (req.body || {}));

  if (nextRole === 'admin') {
    updates.permissions = null;
  } else if (permsTouched || networksTouched || (role && nextRole === 'child')) {
    let bodyForPerms = req.body || {};
    if (networksTouched) {
      const networks = await accountNetworksFor(req);
      const allowedIds = resolveAllowedClientIds(
        req.body,
        networks,
        existing.clientId || req.user.clientId || req.client?.id
      );
      bodyForPerms = { ...req.body, allowedClientIds: allowedIds };
      if (allowedIds[0] && allowedIds[0] !== existing.clientId) {
        updates.clientId = allowedIds[0];
      } else if (allowedIds[0]) {
        updates.clientId = allowedIds[0];
      }
    }
    updates.permissions = mergePermissionsFromBody(existing.permissions, bodyForPerms);
  }



  try {

    const updated = await updateUser(req.params.id, updates);
    const safe = typeof toAdminSafeUser === 'function'
      ? toAdminSafeUser(updated)
      : (() => {
        if (!updated) return null;
        const { passwordHash, passwordEncrypted, ...rest } = updated;
        return rest;
      })();

    res.json(safe);

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



/** Update all permissions for a domain user (full manual assignment). */

router.put('/:id/permissions', async (req, res) => {

  const existing = await getUserById(req.params.id);

  if (!existing || !await assertSameAccount(req, existing)) return res.status(404).json({ error: 'User not found' });



  if (existing.role === 'admin') {

    return res.status(400).json({ error: 'Admin users have full access; permissions cannot be restricted' });

  }



  try {
    const user = await updateUser(req.params.id, {
      permissions: mergePermissionsFromBody(existing.permissions, req.body),
    });
    res.json(typeof toAdminSafeUser === 'function' ? toAdminSafeUser(user) : user);
  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



router.delete('/:id', async (req, res) => {

  try {
    const existing = await getUserById(req.params.id);
    if (!existing || !await assertSameAccount(req, existing)) {
      return res.status(404).json({ error: 'User not found' });
    }

    await deleteUser(req.params.id);

    res.json({ success: true });

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



module.exports = router;


