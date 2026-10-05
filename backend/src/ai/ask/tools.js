/**
 * Tools the ask-your-data chat may call. Each one reads through the product's own endpoints as the
 * signed-in user, so answers respect the same permissions and filters as the pages. Every input is
 * validated here before anything runs; the model's arguments are never trusted as-is.
 */
const { callRouter } = require('../internalCall');
const { buildFacts } = require('../presetAnalysis');
const { explainFigures, ExplainError } = require('../explain');
const { cleanList, pickLists, PUBLISHER_LIST_KEYS } = require('../presetAnalysis/request');
const gamData = require('./gamData');
const gamDims = require('./gamDims');
const forecast = require('../forecast');
const actions = require('./actions');

const MAX_RESULT_CHARS = 12_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

const PRODUCTS = ['gam', 'admob', 'adsense'];
const PUBLISHERS = ['admob', 'adsense'];
const PAGES = ['dashboard', 'reporting', 'roi'];
const DIMENSIONS = {
  admob: ['app', 'country', 'format', 'platform', 'ad_unit'],
  adsense: ['site', 'country', 'platform', 'ad_unit'],
  gam: ['site', 'domain', 'app', 'ad_unit', 'country', 'device'],
};
const ALL_DIMENSIONS = ['app', 'site', 'domain', 'country', 'format', 'platform', 'device', 'ad_unit'];
const FILTER_KEY_BY_DIM = { app: 'apps', site: 'sites', country: 'countries', format: 'formats', platform: 'platforms', ad_unit: 'adUnits' };
const PRODUCT_LABEL = { gam: 'Google Ad Manager', admob: 'AdMob', adsense: 'AdSense' };

const ROUTERS = {
  admob: () => require('../../routes/admob'),
  adsense: () => require('../../routes/adsense'),
};

class ToolInputError extends Error {}

const filtersSchema = {
  type: 'object',
  description: 'Optional filters. Use exact values from find_filter_values. Omit for all inventory. Google Ad Manager uses sites, domains, apps (app IDs such as com.example.app), adUnits, countries and devices; sites and domains can be combined with each other, but apps, adUnits, countries and devices can only be used on their own, with a split by the same dimension.',
  properties: {
    ...Object.fromEntries(PUBLISHER_LIST_KEYS.map((k) => [k, { type: 'array', items: { type: 'string' } }])),
    domains: { type: 'array', items: { type: 'string' } },
    devices: { type: 'array', items: { type: 'string' } },
  },
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
    description: 'Earnings and traffic split by one dimension, largest first, with each item\'s share of the total. Use it for "how much did site X earn" questions: pass the site in filters (or split by site and read its row). Works for Google Ad Manager (by site or domain), AdMob and AdSense.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PRODUCTS },
        dimension: { type: 'string', enum: ALL_DIMENSIONS, description: 'Google Ad Manager: site, domain. AdMob: app, country, format, platform, ad_unit. AdSense: site, country, platform, ad_unit.' },
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
    description: 'Day-by-day earnings and traffic for a period (Google Ad Manager, AdMob or AdSense), optionally for chosen sites.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { product: { type: 'string', enum: PRODUCTS }, ...dateProps, filters: filtersSchema },
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
    name: 'get_forecast',
    description: 'Projected earnings for the end of the current month (Google Ad Manager, AdMob or AdSense): earned so far, projected month-end with a likely range, the pace against last month, and whether it is on track for the monthly target if one is set. Use it for "how will this month end?", "will we hit the target?" and "what is the forecast?" questions.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { product: { type: 'string', enum: PRODUCTS } },
      required: ['product'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_page',
    description: 'Prepare a button that opens a page of this app, optionally with a date range and filters already applied. Use it when the user asks to open, show, take them to or go to a page ("open AdMob ROI", "show me reporting for site X last week"). It changes nothing; the user clicks the button. Pages: dashboard, reporting, roi, presets (for the product), or forecast / weekly_report (any product). Filters only work for dashboard and reporting, and need exact names from find_filter_values.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PRODUCTS, description: 'Not needed for forecast or weekly_report.' },
        page: { type: 'string', enum: ['dashboard', 'reporting', 'roi', 'presets', 'forecast', 'weekly_report'] },
        ...dateProps,
        filters: filtersSchema,
      },
      required: ['page'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_preset',
    description: 'Prepare a saved preset (a named set of filters) for the dashboard or reporting page of a product. Use it only when the user asks to save a preset or view. The user must press Confirm before anything is saved. Names in filters must be exact (use find_filter_values first). Preset names: up to 40 letters, numbers, spaces and - _ . , & + ( ).',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PRODUCTS },
        page: { type: 'string', enum: ['dashboard', 'reporting'] },
        name: { type: 'string', description: 'The preset name, up to 40 characters.' },
        filters: filtersSchema,
      },
      required: ['product', 'page', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_forecast_target',
    description: 'Prepare setting (or, with 0, removing) the monthly earnings target of a product that the forecast compares against. Use it only when the user asks to set or change a target. The user must press Confirm before it is saved.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PRODUCTS },
        amount: { type: 'number', description: 'The monthly target in the product currency; 0 removes it.' },
      },
      required: ['product', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_filter_values',
    description: 'Look up the exact names of apps, sites, domains, countries, formats or platforms that match a search, so they can be used as filters.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: PRODUCTS },
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
  const given = filters && typeof filters === 'object' ? filters : {};
  const unsupported = Object.entries(given).filter(([k, list]) => !PUBLISHER_LIST_KEYS.includes(k) && cleanList(list).length).map(([k]) => k);
  if (unsupported.length) {
    throw new ToolInputError(`Filter ${unsupported.join(', ')} does not apply to AdMob or AdSense. Allowed: ${PUBLISHER_LIST_KEYS.join(', ')}.`);
  }
  const picked = pickLists(given, PUBLISHER_LIST_KEYS);
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

const GAM_FILTER_KEYS = ['sites', 'domains', 'apps', 'adUnits', 'countries', 'devices'];
const GAM_DIM_FILTER = { site: 'sites', domain: 'domains', app: 'apps', ad_unit: 'adUnits', country: 'countries', device: 'devices' };

/** The Google Ad Manager filters the model asked for, cleaned. Anything else is refused, not ignored. */
function gamFilters(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const unknown = Object.entries(f).filter(([k, list]) => !GAM_FILTER_KEYS.includes(k) && cleanList(list).length).map(([k]) => k);
  if (unknown.length) {
    throw new ToolInputError(`Filter ${unknown.join(', ')} does not apply to Google Ad Manager. Allowed: ${GAM_FILTER_KEYS.join(', ')}.`);
  }
  return Object.fromEntries(GAM_FILTER_KEYS.map((k) => [k, cleanList(f[k] || [])]));
}

/**
 * How a Google Ad Manager split or trend is read.
 * - inventory: by site or domain, from the Dashboard's own rows (sites and domains can be combined).
 * - rollup: by app, ad unit, country or device, from one-dimension daily rollups (a single kind at a time).
 * `dimension` is null for a daily trend, where the filters alone decide.
 */
function gamPlan(dimension, filters, ctx) {
  const used = GAM_FILTER_KEYS.filter((k) => filters[k].length);
  const inventoryKeys = ['sites', 'domains'];
  const rollupUsed = used.filter((k) => !inventoryKeys.includes(k));
  const inventoryUsed = used.filter((k) => inventoryKeys.includes(k));
  if (rollupUsed.length > 1 || (rollupUsed.length && inventoryUsed.length)) {
    throw new ToolInputError(
      `Google Ad Manager cannot combine ${used.join(' and ')} in one answer: the data is stored one dimension at a time (except sites with domains). `
      + 'Ask for one of them, or tell the user it cannot be combined.'
    );
  }
  let kind = null;
  if (rollupUsed.length) kind = Object.keys(GAM_DIM_FILTER).find((d) => GAM_DIM_FILTER[d] === rollupUsed[0]);
  if (dimension && gamDims.KINDS.includes(dimension)) {
    if (kind && kind !== dimension) {
      throw new ToolInputError(`A split by ${dimension} cannot be filtered by ${rollupUsed[0]}. Use the same dimension, or no filter.`);
    }
    if (inventoryUsed.length) {
      throw new ToolInputError(`A split by ${dimension} cannot be filtered by ${inventoryUsed.join(' or ')}. Split by site or domain instead.`);
    }
    kind = dimension;
  } else if (dimension && kind) {
    throw new ToolInputError(`A split by ${dimension} cannot be filtered by ${rollupUsed[0]}. Split by ${kind}, or drop the filter.`);
  }
  if (kind) {
    if (ctx?.role !== 'admin' || !ctx?.clientId) throw new ToolInputError('Splits by app, ad unit, country or device are only available to admins.');
    return { path: 'rollup', kind, values: filters[GAM_DIM_FILTER[kind]] };
  }
  return { path: 'inventory' };
}

/**
 * Filters for a Google Ad Manager summary. The summary reads the Dashboard's own filters (site, domain, country);
 * anything it cannot apply is refused out loud, because a silently ignored filter would make the account total
 * look like the figure for one site.
 */
function gamSummaryFilters(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const given = Object.entries(f).filter(([, list]) => cleanList(list).length).map(([k]) => k);
  if (given.length) {
    throw new ToolInputError(
      'Google Ad Manager totals cannot be filtered here (filters given: '
      + `${given.join(', ')}). For one site or domain call get_breakdown with product "gam", dimension "site" or "domain", and the name in filters; `
      + 'call get_summary without filters for the whole network.'
    );
  }
  return { picked: {} };
}

async function loadGam({ start, end, authorization }) {
  try {
    return await gamData.loadGamRows({ start, end, authorization });
  } catch (err) {
    throw new ToolInputError(err.status === 403 ? 'This user is not allowed to see that data.' : (err.message || 'The data could not be loaded.'));
  }
}

function gamNote(data, extra, nothingMatched) {
  const parts = [];
  if (nothingMatched) parts.push('No rows matched. Check the exact name with find_filter_values, or the period may have no data for it.');
  if (data.warning) parts.push('Some days may still be loading, so totals can be understated.');
  if (extra) parts.push(extra);
  return parts.length ? parts.join(' ') : undefined;
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
  if (name === 'get_forecast') return `Projecting this month's ${product} earnings`;
  if (name === 'open_page') return 'Preparing the page link';
  if (name === 'save_preset') return 'Preparing the preset';
  if (name === 'set_forecast_target') return 'Preparing the target change';
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

/** `ctx` is the signed-in user ({ userId, clientId, role }); GAM splits read their own network by it. */
async function executeTool(name, rawInput, { authorization, ctx }) {
  if (!rawInput || typeof rawInput !== 'object') throw new ToolInputError('Arguments must be an object');
  const input = normalizeInput(rawInput);

  if (name === 'get_summary') {
    const product = requireEnum(input.product, PRODUCTS, 'product');
    const page = requireEnum(input.page, PAGES, 'page');
    const { start, end } = requireRange(input);
    const { picked } = product === 'gam' ? gamSummaryFilters(input.filters, page) : filterQuery(input.filters);
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
    const product = requireEnum(input.product, PRODUCTS, 'product');
    const dimension = requireEnum(input.dimension, DIMENSIONS[product], `dimension for ${product}`);
    const { start, end } = requireRange(input);
    if (product === 'gam') {
      const limit = Math.min(50, Math.max(1, parseInt(input.limit, 10) || 15));
      const filters = gamFilters(input.filters);
      const plan = gamPlan(dimension, filters, ctx);
      if (plan.path === 'rollup') {
        const all = await gamDims.dimBreakdown({ clientId: ctx.clientId, start, end, kind: plan.kind, values: plan.values });
        const totalEarnings = all.reduce((a, r) => a + (r.earnings || 0), 0);
        return limitSize({
          product: PRODUCT_LABEL.gam,
          dimension,
          period: { start, end },
          currency: 'USD',
          total_earnings: round(totalEarnings),
          items_matched: all.length,
          rows: all.slice(0, limit).map((r) => ({
            name: r.name,
            earnings: round(r.earnings),
            share_pct: totalEarnings > 0 ? round((r.earnings / totalEarnings) * 100, 1) : null,
            impressions: r.impressions,
            ecpm: round(r.ecpm),
          })),
          note: [
            all.length === 0 ? 'No rows matched. Check the exact name with find_filter_values, or the period may have no data for it.' : null,
            'From the warehouse rollups, so the network total can differ slightly from the Dashboard total.',
            all.length > limit ? `Only the top ${limit} of ${all.length} are listed; shares are of all ${all.length}.` : null,
          ].filter(Boolean).join(' '),
        });
      }
      const fromRollup = ctx?.role === 'admin' && ctx?.clientId;
      const data = fromRollup ? { currency: 'USD', warning: null } : await loadGam({ start, end, authorization });
      const scoped = fromRollup
        ? await gamDims.inventoryBreakdown({ clientId: ctx.clientId, start, end, field: dimension, sites: filters.sites, domains: filters.domains })
        : gamData.filterRows(data.rows, filters);
      const all = fromRollup ? scoped : gamData.breakdown(scoped, dimension, 5000);
      const totalEarnings = all.reduce((a, r) => a + (r.earnings || 0), 0);
      const rows = all.slice(0, limit);
      return limitSize({
        product: PRODUCT_LABEL.gam,
        dimension,
        period: { start, end },
        currency: data.currency,
        total_earnings: round(totalEarnings),
        items_matched: all.length,
        rows: rows.map((r) => ({
          name: r.name,
          earnings: round(r.earnings),
          share_pct: totalEarnings > 0 ? round((r.earnings / totalEarnings) * 100, 1) : null,
          impressions: r.impressions,
          clicks: r.clicks,
          ecpm: round(r.ecpm),
          ctr_pct: round(r.ctr, 2),
        })),
        note: gamNote(data, all.length > limit ? `Only the top ${limit} of ${all.length} are listed; shares are of all ${all.length}.` : null, scoped.length === 0),
      });
    }
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
    const product = requireEnum(input.product, PRODUCTS, 'product');
    const { start, end } = requireRange(input);
    if (product === 'gam') {
      const filters = gamFilters(input.filters);
      const plan = gamPlan(null, filters, ctx);
      if (plan.path === 'rollup') {
        const days = await gamDims.dimTrend({ clientId: ctx.clientId, start, end, kind: plan.kind, values: plan.values });
        return limitSize({
          product: PRODUCT_LABEL.gam,
          currency: 'USD',
          rows: days.map((t) => ({ date: t.date, earnings: round(t.earnings), impressions: t.impressions, ecpm: round(t.ecpm) })),
          note: [
            days.length === 0 ? 'No rows matched. Check the exact name with find_filter_values.' : null,
            'From the warehouse rollups, so totals can differ slightly from the Dashboard.',
          ].filter(Boolean).join(' '),
        });
      }
      const fromRollup = ctx?.role === 'admin' && ctx?.clientId;
      const data = fromRollup ? { currency: 'USD', warning: null } : await loadGam({ start, end, authorization });
      const scoped = fromRollup
        ? await gamDims.inventoryTrend({ clientId: ctx.clientId, start, end, sites: filters.sites, domains: filters.domains })
        : gamData.filterRows(data.rows, filters);
      return limitSize({
        product: PRODUCT_LABEL.gam,
        currency: data.currency,
        rows: (fromRollup ? scoped : gamData.dailyTrend(scoped)).map((t) => ({
          date: t.date, earnings: round(t.earnings), impressions: t.impressions, clicks: t.clicks, ecpm: round(t.ecpm),
        })),
        note: gamNote(data, null, scoped.length === 0),
      });
    }
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
    const { picked } = product === 'gam' ? gamSummaryFilters(input.filters, 'dashboard') : filterQuery(input.filters);
    try {
      return limitSize(await explainFigures({ authorization, body: { product, startDate: start, endDate: end, filters: picked } }));
    } catch (err) {
      if (err instanceof ExplainError) throw new ToolInputError(err.status === 403 ? 'This user is not allowed to see that data.' : err.message);
      throw new ToolInputError(err.message || 'The data could not be loaded.');
    }
  }

  if (name === 'get_forecast') {
    const product = requireEnum(input.product, PRODUCTS, 'product');
    try {
      return limitSize(await forecast.forecastSummary({ authorization, ctx, product }));
    } catch (err) {
      if (err instanceof forecast.ForecastDataError || err instanceof forecast.ForecastRequestError) throw new ToolInputError(err.message);
      throw new ToolInputError(err.message || 'The forecast could not be built.');
    }
  }

  if (name === 'find_filter_values') {
    const product = requireEnum(input.product, PRODUCTS, 'product');
    const dimension = requireEnum(input.dimension, DIMENSIONS[product], `dimension for ${product}`);
    const search = cleanList([input.search || ''])[0]?.toLowerCase() || '';
    const { values, filterKey } = await lookupValues(product, dimension, search, { authorization, ctx });
    return limitSize({ product: PRODUCT_LABEL[product], dimension, filter_key: filterKey, values: values.slice(0, 25), more: values.length > 25 });
  }

  if (ACTION_TOOLS.has(name)) return runActionTool(name, input, { authorization, ctx });

  throw new ToolInputError(`Unknown tool: ${name}`);
}

/** Exact names that match a search, for one product and dimension. */
async function lookupValues(product, dimension, search, { authorization, ctx }) {
  if (product === 'gam') {
    if (gamDims.KINDS.includes(dimension)) {
      if (ctx?.role !== 'admin' || !ctx?.clientId) throw new ToolInputError('Lookups by app, ad unit, country or device are only available to admins.');
      return { values: await gamDims.dimNames({ clientId: ctx.clientId, kind: dimension, search }), filterKey: GAM_DIM_FILTER[dimension] };
    }
    let list;
    if (ctx?.role === 'admin' && ctx?.clientId) {
      list = await gamDims.inventoryNames({ clientId: ctx.clientId, field: dimension, search });
    } else {
      let names;
      try {
        names = await gamData.loadGamNames({ authorization });
      } catch (err) {
        throw new ToolInputError(err.status === 403 ? 'This user is not allowed to see that data.' : (err.message || 'The names could not be loaded.'));
      }
      list = dimension === 'domain' ? names.domains : names.sites;
    }
    return {
      values: list.map(String).filter((v) => v && (!search || v.toLowerCase().includes(search))),
      filterKey: dimension === 'domain' ? 'domains' : 'sites',
    };
  }
  const body = await callPublisher(product, '/filters', {}, authorization);
  const key = FILTER_KEY_BY_DIM[dimension];
  return {
    values: (body.options?.[key] || [])
      .map((o) => String(o.label || o.id || o.value || ''))
      .filter((v) => v && (!search || v.toLowerCase().includes(search))),
    filterKey: key,
  };
}

// ─── actions: the chat proposes, the user confirms on screen ───────────────────

const ACTION_TOOLS = new Set(['open_page', 'save_preset', 'set_forecast_target']);

/**
 * Validates the request and returns a proposal. Nothing is changed here. The proposal travels to the screen in
 * `__action`, which the chat loop strips before the model sees the result.
 */
async function runActionTool(name, input, { authorization, ctx }) {
  const product = input.product ? requireEnum(input.product, PRODUCTS, 'product') : null;
  const lookupCache = new Map();
  // One name lookup per (product, dimension, name); values are matched exactly by the caller.
  const lookup = async (dimension, search) => {
    const key = `${dimension}|${String(search).toLowerCase()}`;
    if (!lookupCache.has(key)) {
      lookupCache.set(key, (await lookupValues(product, dimension, String(search).toLowerCase(), { authorization, ctx })).values);
    }
    return lookupCache.get(key);
  };
  try {
    let action;
    if (name === 'save_preset') {
      if (ctx?.role !== 'admin') throw new ToolInputError('Only admins can save presets from the chat.');
      action = await actions.proposeSavePreset({ ...input, product }, { ctx, lookup });
    } else if (name === 'set_forecast_target') {
      if (ctx?.role !== 'admin') throw new ToolInputError('Only admins can set targets.');
      action = await actions.proposeSetTarget({ ...input, product }, { ctx });
    } else {
      if (input.page !== 'forecast' && input.page !== 'weekly_report' && !product) throw new ToolInputError('product is required for this page');
      action = await actions.proposeOpenPage({ ...input, product }, { lookup });
    }
    return JSON.stringify({
      status: 'prepared_not_done',
      what: action.title,
      details: action.detail,
      instruction: action.confirm
        ? 'The user now sees a card with Confirm and Cancel buttons. Nothing has been changed. Tell them it is ready for them to confirm; never say it is done.'
        : 'The user now sees an Open button. Tell them it is ready; never say you opened it.',
      __action: action,
    });
  } catch (err) {
    if (err instanceof actions.ActionInputError) throw new ToolInputError(err.message);
    throw err;
  }
}

/** Pulls the proposal out of a tool result and returns { content (for the model), action (for the screen) }. */
function splitAction(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed.__action) {
      const { __action: action, ...rest } = parsed;
      return { content: JSON.stringify(rest), action };
    }
  } catch {
    /* not JSON: nothing to split */
  }
  return { content, action: null };
}

module.exports = {
  TOOLS, executeTool, describeCall, splitAction, ToolInputError,
};
