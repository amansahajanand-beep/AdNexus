/** Merge JSON body into req.query for POST report requests (large filter lists). */
function mergePostFilters(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    Object.assign(req.query, req.body);
  }
  next();
}

function registerFilterReportRoute(router, path, handler) {
  router.get(path, handler);
  router.post(path, mergePostFilters, handler);
}

module.exports = { mergePostFilters, registerFilterReportRoute };
