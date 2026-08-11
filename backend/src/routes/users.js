/**

 * Admin user-management routes. Mounted at /api/users.

 */

const express = require('express');

const router = express.Router();

const { requireAdmin } = require('../middleware/auth');

const {

  getUsersByClientId,

  getUserById,

  createUser,

  updateUser,

  deleteUser

} = require('../models/userStore');

const logger = require('../utils/logger');

const { validatePassword } = require('../utils/passwordPolicy');

const { normalizePermissions, FLAG_KEYS, INVENTORY_SCOPE_KEYS } = require('../utils/permissions');
const { cache } = require('../gamClient');
const {
  findCachedInventoryRows,
  buildCatalogFilterOptions,
  rowsToDomainOptions,
  CATALOG_CACHE_KEY,
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
  const cached = cache.get(CATALOG_CACHE_KEY);
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



function assertSameClient(req, user) {
  const cid = req.user.clientId || req.client?.id;
  if (!user || !cid || user.clientId !== cid) return false;
  return true;
}

router.get('/', async (req, res) => {
  try {
    const cid = req.user.clientId || req.client?.id;
    res.json(await getUsersByClientId(cid));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



router.post('/', async (req, res) => {

  const { username, password, email, role } = req.body || {};

  if (!username || !password) {

    return res.status(400).json({ error: 'Username and password are required.' });

  }

  const pwCheck = validatePassword(password, { username: username.trim() });

  if (!pwCheck.valid) {

    return res.status(400).json({ error: pwCheck.errors[0] });

  }

  const userRole = role === 'admin' ? 'admin' : 'child';

  try {

    const user = await createUser({

      username: username.trim(),

      email: email || `${username.trim()}@local`,

      password,

      role: userRole,

      permissions: buildFromBody(userRole, req.body),

      createdBy: req.user.username,

      clientId: req.user.clientId || req.client?.id,

    });
    console.log("User data :",user)
    logger.info(`User created: ${user.username} by ${req.user.username}`);

    res.status(201).json(user);

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



router.put('/:id', async (req, res) => {

  const { username, password, email, role, isActive } = req.body || {};

  const existing = await getUserById(req.params.id);

  if (!existing || !assertSameClient(req, existing)) return res.status(404).json({ error: 'User not found' });



  const updates = {};

  if (username) updates.username = username.trim();

  if (email) updates.email = email;

  if (password) {

    const pwCheck = validatePassword(password, { username: username?.trim() || existing.username });

    if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.errors[0] });

    updates.password = password;

  }

  if (typeof isActive === 'boolean') updates.isActive = isActive;



  const nextRole = role === 'admin' ? 'admin' : role === 'child' ? 'child' : existing.role;

  if (role) updates.role = nextRole;



  const permsTouched = permissionsTouched(req.body || {});

  if (nextRole === 'admin') {
    updates.permissions = null;
  } else if (permsTouched || (role && nextRole === 'child')) {
    updates.permissions = mergePermissionsFromBody(existing.permissions, req.body);
  }



  try {

    const user = await updateUser(req.params.id, updates);

    res.json(user);

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



/** Update all permissions for a domain user (full manual assignment). */

router.put('/:id/permissions', async (req, res) => {

  const existing = await getUserById(req.params.id);

  if (!existing || !assertSameClient(req, existing)) return res.status(404).json({ error: 'User not found' });



  if (existing.role === 'admin') {

    return res.status(400).json({ error: 'Admin users have full access; permissions cannot be restricted' });

  }



  try {
    const user = await updateUser(req.params.id, {
      permissions: mergePermissionsFromBody(existing.permissions, req.body),
    });
    res.json(user);
  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



router.delete('/:id', async (req, res) => {

  try {
    const existing = await getUserById(req.params.id);
    if (!existing || !assertSameClient(req, existing)) {
      return res.status(404).json({ error: 'User not found' });
    }

    await deleteUser(req.params.id);

    res.json({ success: true });

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



module.exports = router;


