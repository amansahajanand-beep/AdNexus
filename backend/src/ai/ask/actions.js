/**
 * Actions the chat can prepare. The chat never changes anything itself: each tool checks the request and returns a
 * proposal, the screen shows it as a card, and only the user's click on "Confirm" (or "Open") runs it, through the
 * same code the pages use. So a mistaken or manipulated request can at worst put a wrong card on screen.
 */
const crypto = require('crypto');
const { validateSavedName, SAVED_NAME_RULES_HINT } = require('../../utils/namePolicy');
const { getAll, MAX_ITEMS } = require('../../models/presetStore');
const forecast = require('../forecast');

const PRESET_NAME_MAX = 40;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const PRODUCT_LABEL = { gam: 'Google Ad Manager', admob: 'AdMob', adsense: 'AdSense' };

/** Page ids the app stores presets under, and the in-app pages the chat may open. */
const PRESET_PAGE = {
  gam: { dashboard: 'dashboard', reporting: 'reporting' },
  admob: { dashboard: 'admob', reporting: 'admob-reporting' },
  adsense: { dashboard: 'adsense', reporting: 'adsense-reporting' },
};
const OPENABLE = {
  gam: { dashboard: '/dashboard', reporting: '/reporting', roi: '/roi', presets: '/presets' },
  admob: { dashboard: '/admob/dashboard', reporting: '/admob/reporting', roi: '/admob/roi', presets: '/admob/presets' },
  adsense: { dashboard: '/adsense/dashboard', reporting: '/adsense/reporting', roi: '/adsense/roi', presets: '/adsense/presets' },
};
const SPECIAL_PAGES = { forecast: '/ai-forecast', weekly_report: '/ai-report' };

/**
 * The chat's filter names -> (dimension to check the value against, key in the saved preset).
 * Only filters the page itself offers can be saved.
 */
const FILTERS = {
  gam: {
    sites: { dimension: 'site', snapshot: 'site' },
    domains: { dimension: 'domain', snapshot: 'domain' },
    apps: { dimension: 'app', snapshot: 'domainId' },
    adUnits: { dimension: 'ad_unit', snapshot: 'domainName' },
    countries: { dimension: 'country', snapshot: 'country' },
  },
  admob: {
    apps: { dimension: 'app', snapshot: 'apps' },
    formats: { dimension: 'format', snapshot: 'formats' },
    countries: { dimension: 'country', snapshot: 'countries' },
    platforms: { dimension: 'platform', snapshot: 'platforms' },
  },
  adsense: {
    sites: { dimension: 'site', snapshot: 'sites' },
    countries: { dimension: 'country', snapshot: 'countries' },
    platforms: { dimension: 'platform', snapshot: 'platforms' },
  },
};

class ActionInputError extends Error {}

const newId = () => crypto.randomBytes(6).toString('hex');
const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);

function requireDate(value, name) {
  if (value == null || value === '') return null;
  if (!YMD.test(String(value)) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new ActionInputError(`${name} must be YYYY-MM-DD`);
  return String(value);
}

/**
 * Check each filter value against the real names (case-insensitively) and return the exact spelling.
 * `lookup(dimension, name)` returns the matching names for a search.
 */
async function resolveFilters(product, filters, lookup) {
  const given = filters && typeof filters === 'object' ? filters : {};
  const rules = FILTERS[product];
  const unknownKeys = Object.entries(given).filter(([k, list]) => !rules[k] && Array.isArray(list) && list.length).map(([k]) => k);
  if (unknownKeys.length) {
    throw new ActionInputError(`${PRODUCT_LABEL[product]} pages cannot be saved with a ${unknownKeys.join(', ')} filter. Allowed: ${Object.keys(rules).join(', ')}.`);
  }
  const snapshot = {};
  const shown = [];
  const missing = [];
  for (const [key, rule] of Object.entries(rules)) {
    const names = [...new Set((Array.isArray(given[key]) ? given[key] : []).map((v) => clean(v)).filter(Boolean))].slice(0, 20);
    if (!names.length) continue;
    const exact = [];
    for (const name of names) {
      const found = (await lookup(rule.dimension, name)).find((v) => String(v).toLowerCase() === name.toLowerCase());
      if (found) exact.push(String(found)); else missing.push(`${key}: ${name}`);
    }
    if (exact.length) {
      snapshot[rule.snapshot] = exact;
      shown.push(`${key} ${exact.join(', ')}`);
    }
  }
  if (missing.length) {
    throw new ActionInputError(`Not found in ${PRODUCT_LABEL[product]}: ${missing.join('; ')}. Look up the exact names with find_filter_values first.`);
  }
  return { snapshot, shown };
}

async function takenPresetNames(userId, presetPage) {
  try {
    const pages = await getAll(userId);
    return (pages[presetPage]?.items || []).map((i) => String(i.name || '').toLowerCase());
  } catch {
    return []; // the screen checks again before saving
  }
}

/** "Save these filters as a preset." */
async function proposeSavePreset(input, { ctx, lookup }) {
  const { product, page } = input;
  const presetPage = PRESET_PAGE[product]?.[page];
  if (!presetPage) throw new ActionInputError('Presets can be saved for the dashboard or reporting page of a product.');
  const name = clean(input.name, 80);
  const check = validateSavedName(name, { maxLength: PRESET_NAME_MAX, label: 'Preset name' });
  if (!check.valid) throw new ActionInputError(`${check.error} (${SAVED_NAME_RULES_HINT || 'use letters, numbers and spaces'})`);
  const { snapshot, shown } = await resolveFilters(product, input.filters, lookup);
  const existing = await takenPresetNames(ctx?.userId, presetPage);
  if (existing.includes(name.toLowerCase())) throw new ActionInputError(`A preset named "${name}" already exists on that page. Ask the user for a different name.`);
  if (existing.length >= MAX_ITEMS) throw new ActionInputError(`That page already has the maximum of ${MAX_ITEMS} presets.`);
  return {
    id: newId(),
    type: 'save_preset',
    product,
    page,
    presetPage,
    name,
    snapshot,
    title: `Save preset "${name}"`,
    detail: `${PRODUCT_LABEL[product]} ${page}${shown.length ? ` · ${shown.join(' · ')}` : ' · no filters'}`,
    confirm: true,
  };
}

/** "Open that page (optionally with filters and dates)." */
async function proposeOpenPage(input, { lookup }) {
  const page = clean(input.page).toLowerCase().replace(/[\s-]+/g, '_');
  if (SPECIAL_PAGES[page]) {
    return { id: newId(), type: 'open_page', href: SPECIAL_PAGES[page], title: page === 'forecast' ? 'Open Forecast' : 'Open Weekly report', detail: 'Opens in this app', confirm: false };
  }
  const path = OPENABLE[input.product]?.[page];
  if (!path) throw new ActionInputError(`Pages: ${[...Object.keys(OPENABLE.gam), ...Object.keys(SPECIAL_PAGES)].join(', ')}.`);
  const startDate = requireDate(input.start_date, 'start_date');
  const endDate = requireDate(input.end_date, 'end_date');
  if ((startDate && !endDate) || (!startDate && endDate)) throw new ActionInputError('Give both start_date and end_date, or neither.');
  if (startDate && startDate > endDate) throw new ActionInputError('start_date must not be after end_date');
  const wantsFilters = input.filters && Object.values(input.filters).some((l) => Array.isArray(l) && l.length);
  let snapshot = {};
  let shown = [];
  if (wantsFilters) {
    if (!['dashboard', 'reporting'].includes(page)) throw new ActionInputError('Filters can only be applied when opening the dashboard or reporting page.');
    ({ snapshot, shown } = await resolveFilters(input.product, input.filters, lookup));
  }
  const label = `${PRODUCT_LABEL[input.product]} ${page}`;
  return {
    id: newId(),
    type: 'open_page',
    product: input.product,
    page,
    presetPage: PRESET_PAGE[input.product]?.[page] || null,
    path,
    snapshot,
    startDate,
    endDate,
    title: `Open ${label}`,
    detail: [startDate ? `${startDate} to ${endDate}` : null, ...shown].filter(Boolean).join(' · ') || 'Opens in this app',
    confirm: false,
  };
}

/** "Set (or clear) the monthly earnings target." */
async function proposeSetTarget(input, { ctx }) {
  const product = input.product;
  const amount = input.amount === '' || input.amount == null ? NaN : Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new ActionInputError('amount must be a number: a positive monthly target, or 0 to remove it.');
  let current = null;
  try {
    current = await forecast.getTarget(await forecast.accountIdFor(ctx), product);
  } catch {
    current = null;
  }
  const rounded = Math.round(amount * 100) / 100;
  return {
    id: newId(),
    type: 'set_forecast_target',
    product,
    amount: rounded,
    current,
    title: rounded > 0 ? `Set the ${PRODUCT_LABEL[product]} monthly target to ${rounded.toLocaleString('en-US')}` : `Remove the ${PRODUCT_LABEL[product]} monthly target`,
    detail: current ? `Currently ${current.toLocaleString('en-US')}` : 'No target set now',
    confirm: true,
  };
}

module.exports = {
  proposeSavePreset, proposeOpenPage, proposeSetTarget, ActionInputError, FILTERS, PRODUCT_LABEL, PRESET_NAME_MAX,
};
