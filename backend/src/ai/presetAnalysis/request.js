/**
 * Turn the client's request into a validated, normalized analysis request.
 * The client sends the saved preset's filters and a date range; nothing it sends is passed to an
 * endpoint unchecked, and free text from the client (preset names) never reaches the model.
 */
const { shiftYMD } = require('../../utils/datetime');

const PRODUCTS = ['gam', 'admob', 'adsense'];
const KINDS = ['dashboard', 'reporting', 'roi'];
const MAX_DAYS = 400;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const PUBLISHER_LIST_KEYS = [
  'apps', 'formats', 'countries', 'platforms', 'sites',
  'adUnits', 'adSources', 'adSourceInstances', 'mediationGroups',
];
const GAM_LIST_KEYS = ['domain', 'site', 'domainName', 'domainId', 'country'];
const GAM_REPORT_KEYS = ['reportDimensions', 'reportMetrics'];
const GAM_ROI_KEYS = ['accountIds', 'campaignIds', 'appKeys', 'siteKeys', 'countryCodes'];
const PUBLISHER_ROI_KEYS = ['accountIds', 'apps', 'sites'];

class RequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestError';
    this.status = 400;
  }
}

function cleanList(value) {
  const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).trim();
    if (!s || s === '__ALL__' || s.length > 200) continue;
    out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

function pickLists(source, keys) {
  const out = {};
  for (const k of keys) {
    const list = cleanList(source?.[k]);
    if (list.length) out[k] = list;
  }
  return out;
}

function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

/** The equal-length period directly before the selected one. */
function previousRange(start, end) {
  const days = daysBetween(start, end);
  const prevEnd = shiftYMD(start, -1);
  return { startDate: shiftYMD(prevEnd, -(days - 1)), endDate: prevEnd, days };
}

const LABELS = {
  apps: 'Apps', formats: 'Formats', countries: 'Countries', platforms: 'Platforms', sites: 'Sites',
  adUnits: 'Ad units', adSources: 'Ad sources', adSourceInstances: 'Ad source instances',
  mediationGroups: 'Mediation groups', domain: 'Domains', site: 'Sites', domainName: 'Ad units',
  domainId: 'Apps', country: 'Countries', accountIds: 'Ads accounts', campaignIds: 'Campaigns',
  appKeys: 'Apps', siteKeys: 'Sites', countryCodes: 'Countries',
};

/** Short, server-built description of the filters, e.g. "Apps (2): Block Quest, Idle Farm". */
function describeFilters(filters) {
  const parts = [];
  for (const [key, list] of Object.entries(filters || {})) {
    if (!LABELS[key] || !Array.isArray(list) || !list.length) continue;
    const shown = list.slice(0, 3).map((v) => (v.length > 40 ? `${v.slice(0, 37)}...` : v)).join(', ');
    parts.push(`${LABELS[key]} (${list.length}): ${shown}${list.length > 3 ? ', ...' : ''}`);
  }
  return parts.length ? parts.join(' · ') : 'All inventory';
}

/**
 * @param {object} body  { product, kind, startDate, endDate, filters, depth, force }
 * @returns {{product, kind, start, end, days, compare, filters, filterText, depth, force}}
 */
function parseRequest(body = {}) {
  const product = String(body.product || '');
  const kind = String(body.kind || '');
  if (!PRODUCTS.includes(product)) throw new RequestError('Unknown product');
  if (!KINDS.includes(kind)) throw new RequestError('Unknown analysis type');

  const start = String(body.startDate || '');
  const end = String(body.endDate || '');
  if (!YMD.test(start) || !YMD.test(end)) throw new RequestError('startDate and endDate must be YYYY-MM-DD');
  const days = daysBetween(start, end);
  if (!(days >= 1) || days > MAX_DAYS) throw new RequestError(`Date range must be between 1 and ${MAX_DAYS} days`);

  const src = body.filters && typeof body.filters === 'object' ? body.filters : {};
  let filters;
  if (product === 'gam') {
    if (kind === 'roi') filters = pickLists(src, GAM_ROI_KEYS);
    else if (kind === 'reporting') filters = pickLists(src, [...GAM_LIST_KEYS, ...GAM_REPORT_KEYS]);
    else filters = pickLists(src, GAM_LIST_KEYS);
  } else if (kind === 'roi') {
    filters = pickLists(src, PUBLISHER_ROI_KEYS);
  } else {
    filters = pickLists(src, PUBLISHER_LIST_KEYS);
  }

  const compare = previousRange(start, end);
  const { reportDimensions, reportMetrics, ...inventoryFilters } = filters;
  return {
    product,
    kind,
    start,
    end,
    days,
    compare: { start: compare.startDate, end: compare.endDate },
    filters,
    filterText: describeFilters(inventoryFilters),
    depth: body.depth === 'deep' ? 'deep' : 'fast',
    force: body.force === true,
  };
}

module.exports = {
  parseRequest, RequestError, previousRange, daysBetween, describeFilters, cleanList, pickLists, PUBLISHER_LIST_KEYS,
};
