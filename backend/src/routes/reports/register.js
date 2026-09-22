/** Merge JSON body into req.query for POST report requests (large filter lists). */
function mergePostFilters(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const merged = { ...req.body };
    // Handlers historically check string 'true'/'1'; POST JSON sends real booleans.
    for (const key of Object.keys(merged)) {
      if (typeof merged[key] === 'boolean') {
        merged[key] = merged[key] ? 'true' : 'false';
      }
    }
    Object.assign(req.query, merged);
  }
  next();
}

function bindHandler(handler) {
  const { bindRequestClient } = require('../../utils/clientContext');
  return bindRequestClient(handler);
}

function registerFilterReportRoute(router, path, handler) {
  const wrapped = bindHandler(handler);
  router.get(path, wrapped);
  router.post(path, mergePostFilters, wrapped);
}

module.exports = { mergePostFilters, registerFilterReportRoute };
