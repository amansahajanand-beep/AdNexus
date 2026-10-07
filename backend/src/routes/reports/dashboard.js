const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const { timezoneOptions, SRC_TZ, isValidTz, coverage } = require('../../services/hourlyView');
const { getNetworkTz } = require('../../services/networkTimezone');
const { todayInTZ } = require('../../utils/datetime');
const { registerFilterReportRoute } = require('./register');
const {
  handleDashboardOverview,
  handleDashboard,
  handleSummary,
  handleTrend,
  handleByAdType,
  handleTopAdvertisers,
} = require('../../services/reportCore');

registerFilterReportRoute(router, '/dashboard/overview', handleDashboardOverview);
registerFilterReportRoute(router, '/dashboard', handleDashboard);
router.get('/summary', handleSummary);
router.get('/trend', handleTrend);
router.get('/by-ad-type', handleByAdType);
router.get('/top-advertisers', handleTopAdvertisers);

/** Timezones offered by the Dashboard picker, starting from this network's own timezone. */
router.get('/timezones', async (req, res) => {
  const srcTz = await getNetworkTz(req.client).catch(() => SRC_TZ);
  const out = { networkTz: srcTz, options: timezoneOptions(srcTz), hourlyFrom: null };
  try {
    const tz = String(req.query.tz || '').trim();
    const clientId = req.client?.id || req.user?.clientId;
    if (tz && tz !== srcTz && isValidTz(tz) && clientId) {
      const cov = await coverage(clientId, tz, todayInTZ(tz), srcTz);
      out.hourlyFrom = cov?.from || null;
      out.partialDay = cov?.partialDay || null;
      // The newest hours are not stored yet: "today" in this zone cannot be shown until the sync catches up.
      out.stale = !cov || cov.through < todayInTZ(tz);
    }
  } catch (err) {
    // The picker still works without the coverage note.
  }
  res.json(out);
});

/** Admin: fetch missing hourly days now (default last 30 days, up to 10 days per call). */
router.post('/hourly/backfill', requireAdmin, async (req, res) => {
  try {
    const { ensureHourlyCoverage } = require('../../services/hourlySyncService');
    const days = Math.min(120, Math.max(1, parseInt(req.body?.days, 10) || 30));
    const maxDays = Math.min(10, Math.max(1, parseInt(req.body?.maxDays, 10) || 6));
    res.json({ ok: true, filled: await ensureHourlyCoverage({ days, maxDays, clientId: req.client?.id || req.user.clientId }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
