const express = require('express');
const router = express.Router();
const { registerFilterReportRoute } = require('./register');
const {
  handleRangeReport,
  handleDomainUserReport,
  handleDetailedReport,
  handleProgrammaticReport,
} = require('../../services/reportCore');

registerFilterReportRoute(router, '/range', handleRangeReport);
registerFilterReportRoute(router, '/domain-user', handleDomainUserReport);
registerFilterReportRoute(router, '/detailed', handleDetailedReport);
registerFilterReportRoute(router, '/programmatic', handleProgrammaticReport);

module.exports = router;
