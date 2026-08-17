/**
 * Facade for GAM helpers used by sync/report workers.
 * Transport is always available (no Express). Live report runners
 * (detailed / programmatic) are registered when the reports route module loads.
 */
const transport = require('../gam/reportTransport');

let _live = {
  runDetailedReport: null,
  runProgrammaticReport: null,
};

function registerLiveReports({ runDetailedReport, runProgrammaticReport } = {}) {
  if (typeof runDetailedReport === 'function') {
    _live.runDetailedReport = runDetailedReport;
  }
  if (typeof runProgrammaticReport === 'function') {
    _live.runProgrammaticReport = runProgrammaticReport;
  }
}

function getHelpers() {
  return {
    getToken: transport.getToken,
    runReportAndDownload: transport.runReportAndDownload,
    buildDateXML: transport.buildDateXML,
    gamSOAP: transport.gamSOAP,
    fetchWithDedup: transport.fetchWithDedup,
    runDetailedReport: _live.runDetailedReport,
    runProgrammaticReport: _live.runProgrammaticReport,
  };
}

function helpersReady() {
  return Boolean(transport.getToken && transport.runReportAndDownload && transport.buildDateXML);
}

function liveReportsReady() {
  return Boolean(_live.runDetailedReport && _live.runProgrammaticReport);
}

module.exports = {
  ...transport,
  registerLiveReports,
  getHelpers,
  helpersReady,
  liveReportsReady,
};
