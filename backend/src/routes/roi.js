const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getRoiSummary } = require('../services/roiService');
const { todayInTZ } = require('../utils/datetime');
const { resolveAdsAccountIdsForUser, getAllowedClientIds } = require('../utils/permissions');
const { mergeRoiParts } = require('../services/roiMerge');
const { roiInventoryScope, limitKeys } = require('../services/roiScope');
const logger = require('../utils/logger');

router.use(requireAuth);

router.get('/summary', async (req, res) => {
  try {
    // Always recompute — metrics (impressions/clicks/eCPM) change with Ads sync.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    const clientId = req.client?.id || req.user.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });

    const end = req.query.end || todayInTZ();
    const start = req.query.start || end;
    const targetType = ['site', 'app', 'all'].includes(req.query.targetType)
      ? req.query.targetType
      : 'all';

    const parseCsv = (v) => String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const requestedAccountIds = parseCsv(req.query.accountIds);
    const accountIds = resolveAdsAccountIdsForUser(req.user, requestedAccountIds);
    const campaignIds = parseCsv(req.query.campaignIds);
    const appKeys = parseCsv(req.query.appKeys);
    const siteKeys = parseCsv(req.query.siteKeys);
    const countryCodes = parseCsv(req.query.countryCodes);

    const includeRows = req.query.includeRows === '1' || req.query.includeRows === 'true';
    const summaryOnly = req.query.summaryOnly === '1' || req.query.summaryOnly === 'true';
    const breakdownOnly = req.query.breakdownOnly === '1' || req.query.breakdownOnly === 'true';
    const includeDaily = req.query.includeDaily === '0' || req.query.includeDaily === 'false'
      ? false
      : (req.query.includeDaily === '1' || req.query.includeDaily === 'true' ? true : null);

    // The zone the user is viewing (same header the Dashboard and Reporting send): earnings follow it.
    const viewTz = String(req.headers['x-report-tz'] || req.query.tz || '').trim() || null;
    const baseOpts = {
      viewTz,
      start,
      end,
      targetType,
      accountIds: accountIds && accountIds.length ? accountIds : null,
      campaignIds: campaignIds.length ? campaignIds : null,
      appKeys: appKeys.length ? appKeys : null,
      siteKeys: siteKeys.length ? siteKeys : null,
      countryCodes: countryCodes.length ? countryCodes : null,
      includeRows,
      summaryOnly,
      breakdownOnly,
      includeDaily,
    };
    // A domain user only ever sees their assigned sites and apps (assigned domains count for every site under them),
    // whatever the page asks for. Each network resolves the assignment against its own site list.
    const optsFor = async (id) => {
      const scope = await roiInventoryScope(req.user, id);
      if (!scope) return baseOpts;
      const host = (v) => String(v || '').trim().toLowerCase().replace(/^www\./, '');
      return {
        ...baseOpts,
        siteKeys: limitKeys(siteKeys, scope.sites, host),
        appKeys: limitKeys(appKeys, scope.apps, (v) => String(v).trim().toLowerCase()),
      };
    };

    // A domain user with several networks sees them together (the Dashboard does the same): each network's ROI is
    // worked out on its own and the results are added up. An explicit network (X-Gam-Client-Id / ?clientId=) still
    // shows just that one.
    let data;
    const pinned = req.headers['x-gam-client-id'] || req.query.clientId;
    const networkIds = req.user.role === 'admin' || pinned ? [] : (getAllowedClientIds(req.user) || []);
    if (networkIds.length > 1) {
      const { getClientById } = require('../models/clientStore');
      const { runWithClient } = require('../utils/clientContext');
      const results = await Promise.allSettled(networkIds.map(async (id) => {
        const runtime = id === String(clientId) ? (req.client || await getClientById(id)) : await getClientById(id);
        if (!runtime) return null;
        // Some loaders read the active network from the request context, so each runs inside its own.
        const opts = await optsFor(id);
        return runWithClient(runtime, () => getRoiSummary(id, opts));
      }));
      const parts = results.filter((r) => r.status === 'fulfilled').map((r) => r.value).filter(Boolean);
      if (!parts.length) {
        const failed = results.find((r) => r.status === 'rejected');
        throw failed ? failed.reason : new Error('No network data');
      }
      results.filter((r) => r.status === 'rejected').forEach((r) => logger.warn(`ROI network skipped: ${r.reason?.message}`));
      data = { ...mergeRoiParts(parts), networks: networkIds.length, networksLoaded: parts.length };
      const metas = parts.map((p) => p.earnTimezone).filter(Boolean);
      // One note for the combined view: the first network whose earnings could not follow the zone, else the zone.
      if (metas.length) data.earnTimezone = metas.find((m) => m.applied === false) || metas[0];
    } else {
      data = await getRoiSummary(clientId, await optsFor(clientId));
    }
    res.json({
      start,
      end,
      targetType,
      accountIds: accountIds && accountIds.length ? accountIds : null,
      campaignIds: campaignIds.length ? campaignIds : null,
      appKeys: appKeys.length ? appKeys : null,
      siteKeys: siteKeys.length ? siteKeys : null,
      countryCodes: countryCodes.length ? countryCodes : null,
      ...data,
    });
  } catch (err) {
    logger.error('ROI summary:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
