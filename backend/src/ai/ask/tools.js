/**
 * Tools the ask-your-data chat may call. Each one reads through the product's own endpoints as the
 * signed-in user, so answers respect the same permissions and filters as the pages. Every input is
 * validated here before anything runs; the model's arguments are never trusted as-is.
 */
const { callRouter } = require('../internalCall');
const { buildFacts } = require('../presetAnalysis');
const { explainFigures, ExplainError } = require('../explain');
const { cleanList, pickLists, PUBLISHER_LIST_KEYS } = require('../presetAnalysis/request');

const MAX_RESULT_CHARS = 12_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

const PRODUCTS = ['gam', 'admob', 'adsense'];
const PUBLISHERS = ['admob', 'adsense'];
const PAGES = ['dashboard', 'reporting', 'roi'];
const DIMENSIONS = { admob: ['app', 'country', 'format', 'platform', 'ad_unit'], adsense: ['site', 'country', 'platform', 'ad_unit'] };
const ALL_DIMENSIONS = ['app', 'site', 'country', 'format', 'platform', 'ad_unit'];
const FILTER_KEY_BY_DIM = { app: 'apps', site: 'sites', country: 'countries', format: 'formats', platform: 'platforms', ad_unit: 'adUnits' };
const PRODUCT_LABEL = { gam: 'Google Ad Manager', admob: 'AdMob', adsense: 'AdSense' };

const ROUTERS = {
  admob: () => require('../../routes/admob'),
  adsense: () => require('../../routes/adsense'),
};

class ToolInputError extends Error {}

const filtersSchema = {
  type: 'object',
  description: 'Optional filters. Use exact values from find_filter_values. Omit for all inventory.',
  properties: Object.fromEntries(PUBLISHER_LIST_KEYS.map((k) => [k, { type: 'array', items: { type: 'string' } }])),
  additionalProperties: false,
};
const dateProps = {
  start_date: { type: 'string', description: 'First day, YYYY-MM-DD.' },
  end_date: { type: 'string', description: 'Last day, YYYY-MM-DD (inclusive).' },
};

const TOOLS = [
  {
    name: 'get_summary',
    description: 'Key figures for a period compared with the equal-length period before it: totals with % change, top items, unusual days, and rule-detected problems. Use page "roi" for Google Ads spend vs earnings. This is the best first call for most questions.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PRODUCTS },
        page: { type: 'string', enum: PAGES, description: 'dashboard = overview, reporting = more breakdowns, roi = spend vs earnings.' },
        ...dateProps,
        filters: filtersSchema,
      },
      required: ['product', 'page', 'start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_breakdown',
    description: 'Earnings and traffic split by one dimension (AdMob or AdSense only), largest first, with each item\'s share of the total.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PUBLISHERS },
        dimension: { type: 'string', enum: ALL_DIMENSIONS, description: 'AdMob: app, country, format, platform, ad_unit. AdSense: site, country, platform, ad_unit.' },
        ...dateProps,
        filters: filtersSchema,
        limit: { type: 'integer', description: 'How many rows, 1 to 50. Default 15.' },
      },
      required: ['product', 'dimension', 'start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_daily_trend',
    description: 'Day-by-day earnings and traffic for a period (AdMob or AdSense only).',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { product: { type: 'string', enum: PUBLISHERS }, ...dateProps, filters: filtersSchema },
      required: ['product', 'start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_change',
    description: 'Why earnings changed between a period and the equal-length period before it. Splits the change into traffic, price, shifts between items, and new or lost items, and lists the biggest movers by app, site, country, format or platform with their share of the change. Use this for "why did earnings drop or rise?" questions; call get_summary first only if you also need other figures.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { product: { type: 'string', enum: PRODUCTS }, ...dateProps, filters: filtersSchema },
      required: ['product', 'start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_filter_values',
    description: 'Look up the exact names of apps, sites, countries, formats or platforms that match a search, so they can be used as filters.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PUBLISHERS },
        dimension: { type: 'string', enum: ALL_DIMENSIONS },
        search: { type: 'string', description: 'Part of a name, e.g. "quiz". Empty returns the first values.' },
      },
      required: ['product', 'dimension'],
      additionalProperties: false,
    },
  },
];

function requireEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new ToolInputError(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

function requireRange(input) {
  const start = String(input.start_date || '');
  const end = String(input.end_date || '');
  if (!YMD.test(start) || !YMD.test(end)) throw new ToolInputError('start_date and end_date must be YYYY-MM-DD');
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (!(days >= 1) || days > MAX_DAYS) throw new ToolInputError(`The period must be 1 to ${MAX_DAYS} days`);
  return { start, end, days };
}

function filterQuery(filters) {
  const picked = pickLists(filters && typeof filters === 'object' ? filters : {}, PUBLISHER_LIST_KEYS);
  const q = {};
  for (const [k, list] of Object.entries(picked)) q[k] = list.join(',');
  return { picked, q };
}

function limitSize(obj) {
  let text = JSON.stringify(obj);
  if (text.length <= MAX_RESULT_CHARS) return text;
  if (Array.isArray(obj.rows)) {
    const copy = { ...obj, rows: obj.rows.slice() };
    while (copy.rows.length > 1 && JSON.stringify(copy).length > MAX_RESULT_CHARS) copy.rows.pop();
    copy.note = 'Rows were cut to keep the answer short.';
    text = JSON.stringify(copy);
  }
  return text.slice(0, MAX_RESULT_CHARS);
}

async function callPublisher(product, path, query, authorization) {
  const res = await callRouter(ROUTERS[product](), { path, query, authorization, timeoutMs: 20_000 });
  if (res.status !== 200) {
    const reason = res.status === 403 ? 'This user is not allowed to see that data.' : (res.body?.error || 'The data could not be loaded.');
    throw new ToolInputError(reason);
  }
  return res.body;
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const round = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(d)));

/** Short label for the progress line shown while a tool runs. */
function describeCall(name, input) {
  const product = PRODUCT_LABEL[input?.product] || 'data';
  const period = input?.start_date && input?.end_date
    ? (input.start_date === input.end_date ? input.start_date : `${input.start_date} to ${input.end_date}`)
    : '';
  if (name === 'get_summary') return `Reading ${product} ${input?.page === 'roi' ? 'ROI' : input?.page || 'summary'}${period ? ` for ${period}` : ''}`;
  if (name === 'get_breakdown') return `Splitting ${product} by ${String(input?.dimension || '').replace('_', ' ')}${period ? ` for ${period}` : ''}`;
  if (name === 'get_daily_trend') return `Reading daily ${product} figures${period ? ` for ${period}` : ''}`;
  if (name === 'explain_change') return `Working out what changed in ${product}${period ? ` (${period})` : ''}`;
  if (name === 'find_filter_values') return `Looking up ${product} ${String(input?.dimension || '').replace('_', ' ')} names`;
  return 'Reading data';
}

/** Models sometimes write "AdSense" or " Site " where the schema wants "adsense" / "site". */
function normalizeInput(input) {
  const out = { ...input };
  for (const key of ['product', 'page', 'dimension']) {
    if (typeof out[key] === 'string') out[key] = out[key].trim().toLowerCase().replace(/[\s-]+/g, '_');
  }
  if (out.product === 'google_ad_manager' || out.product === 'ad_manager') out.product = 'gam';
  if (typeof out.limit === 'string') out.limit = parseInt(out.limit, 10);
  return out;
}

async function executeTool(name, rawInput, { authorization }) {
  if (!rawInput || typeof rawInput !== 'object') throw new ToolInputError('Arguments must be an object');
  const input = normalizeInput(rawInput);

  if (name === 'get_summary') {
    const product = requireEnum(input.product, PRODUCTS, 'product');
    const page = requireEnum(input.page, PAGES, 'page');
    const { start, end } = requireRange(input);
    const { picked } = filterQuery(input.filters);
    let result;
    try {
      result = await buildFacts({
        authorization,
        body: { product, kind: page, startDate: start, endDate: end, filters: picked, depth: 'fast' },
      });
    } catch (err) {
      throw new ToolInputError(err.status === 403 ? 'This user is not allowed to see that data.' : (err.message || 'The data could not be loaded.'));
    }
    const p = result.final.prompt;
    return limitSize({
      page: p.page,
      period: p.period,
      compared_with: p.compared_with,
      currency: p.currency,
      filters: p.filters,
      no_data: result.final.noData,
      notes: p.notes,
      facts: Object.values(p.facts),
      daily_trend: p.daily_trend,
      detected_problems: p.detected_signals.map((s) => `[${s.severity}] ${s.title}: ${s.text}`),
    });
  }

  if (name === 'get_breakdown') {
    const product = requireEnum(input.product, PUBLISHERS, 'product');
    const dimension = requireEnum(input.dimension, DIMENSIONS[product], `dimension for ${product}`);
    const { start, end } = requireRange(input);
    const { q } = filterQuery(input.filters);
    const limit = Math.min(50, Math.max(1, parseInt(input.limit, 10) || 15));
    const body = await callPublisher(product, '/breakdowns', { startDate: start, endDate: end, dim: dimension, limit, ...q }, authorization);
    const rows = body.rows || [];
    const total = rows.reduce((a, r) => a + (num(r.earnings) || 0), 0);
    return limitSize({
      product: PRODUCT_LABEL[product],
      dimension,
      period: { start, end },
      rows: rows.map((r) => ({
        name: r.name,
        earnings: round(r.earnings),
        share_pct: total > 0 && r.earnings != null ? round((num(r.earnings) / total) * 100, 1) : null,
        impressions: num(r.impressions),
        page_views: num(r.page_views),
        clicks: num(r.clicks),
        ecpm: round(r.ecpm),
        rpm: round(r.rpm),
        ctr_pct: round(r.ctr, 2),
      })),
      note: rows.length >= limit ? `Only the top ${limit} are listed; shares are of these rows.` : undefined,
    });
  }

  if (name === 'get_daily_trend') {
    const product = requireEnum(input.product, PUBLISHERS, 'product');
    const { start, end } = requireRange(input);
    const { q } = filterQuery(input.filters);
    const body = await callPublisher(product, '/trend', { startDate: start, endDate: end, ...q }, authorization);
    return limitSize({
      product: PRODUCT_LABEL[product],
      currency: body.currency,
      rows: (body.trend || []).map((t) => ({
        date: t.date,
        earnings: round(t.earnings),
        impressions: num(t.impressions),
        page_views: num(t.page_views),
        clicks: num(t.clicks),
        ecpm: round(t.ecpm),
        rpm: round(t.rpm),
      })),
    });
  }

  if (name === 'explain_change') {
    const product = requireEnum(input.product, PRODUCTS, 'product');
    const { start, end } = requireRange(input);
    const { picked } = filterQuery(input.filters);
    try {
      return limitSize(await explainFigures({ authorization, body: { product, startDate: start, endDate: end, filters: picked } }));
    } catch (err) {
      if (err instanceof ExplainError) throw new ToolInputError(err.status === 403 ? 'This user is not allowed to see that data.' : err.message);
      throw new ToolInputError(err.message || 'The data could not be loaded.');
    }
  }

  if (name === 'find_filter_values') {
    const product = requireEnum(input.product, PUBLISHERS, 'product');
    const dimension = requireEnum(input.dimension, DIMENSIONS[product], `dimension for ${product}`);
    const search = cleanList([input.search || ''])[0]?.toLowerCase() || '';
    const body = await callPublisher(product, '/filters', {}, authorization);
    const key = FILTER_KEY_BY_DIM[dimension];
    const values = (body.options?.[key] || [])
      .map((o) => String(o.label || o.id || o.value || ''))
      .filter((v) => v && (!search || v.toLowerCase().includes(search)));
    return limitSize({ product: PRODUCT_LABEL[product], dimension, filter_key: key, values: values.slice(0, 25), more: values.length > 25 });
  }

  throw new ToolInputError(`Unknown tool: ${name}`);
}

module.exports = { TOOLS, executeTool, describeCall, ToolInputError };
