const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getRoiSummary } = require('../services/roiService');
const { todayInTZ } = require('../utils/datetime');
const { resolveAdsAccountIdsForUser } = require('../utils/permissions');
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

    const data = await getRoiSummary(clientId, {
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
    });
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
