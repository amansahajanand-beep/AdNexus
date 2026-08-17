/**
 * Reports HTTP entry — auth + thin routers.
 * Handlers live in services/reportCore.js (fetch policy unchanged).
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { registerLiveReports, getHelpers } = require('../services/gamHelpers');
const { runDetailedReport, runProgrammaticReport } = require('../services/reportCore');

router.use(requireAuth);
router.use(require('./reports/dashboard'));
router.use(require('./reports/catalog'));
router.use(require('./reports/detailed'));

registerLiveReports({ runDetailedReport, runProgrammaticReport });
router.__gamHelpers = getHelpers();

module.exports = router;
