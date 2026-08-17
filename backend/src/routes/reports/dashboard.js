const express = require('express');
const router = express.Router();
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

module.exports = router;
