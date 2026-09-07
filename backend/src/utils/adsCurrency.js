/**
 * Convert Google Ads account-currency amounts → USD using live / historical FX.
 * Historical rates are keyed by spend date so yesterday's INR spend is not
 * converted with today's USD rate (which caused Ads UI mismatches).
 */

const logger = require('./logger');

/** Last-resort only if every live FX endpoint fails. */
const EMERGENCY_UNITS_PER_USD = {
  USD: 1,
  INR: 88,
  EUR: 0.92,
  GBP: 0.79,
  AED: 3.67,
  SGD: 1.35,
  AUD: 1.55,
  CAD: 1.38,
};

/** @type {Map<string, Record<string, number>>} ymd → { USD:1, INR:… } */
const ratesByDate = new Map();
let latestRates = null;
let latestDay = '';

function normalizeCurrency(code) {
  const c = String(code || 'USD').trim().toUpperCase();
  return c.length === 3 ? c : 'USD';
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function isYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Normalize a map of { CUR: unitsPerOneUsd } */
function pickRates(raw) {
  const rates = { USD: 1 };
  Object.entries(raw || {}).forEach(([code, val]) => {
    const c = String(code || '').toUpperCase();
    const n = Number(val);
    if (c.length === 3 && n > 0) rates[c] = n;
  });
  return rates;
}

function ratesFromUsdJson(data) {
  const usd = data?.usd || {};
  const rates = { USD: 1 };
  Object.entries(usd).forEach(([code, val]) => {
    const c = String(code || '').toUpperCase();
    const n = Number(val);
    if (c.length === 3 && n > 0) rates[c] = n;
  });
  return rates.INR ? rates : null;
}

/**
 * Live / latest providers (INR included). Values = how many units of that currency = 1 USD.
 */
async function refreshRatesFromNetwork() {
  const errors = [];

  try {
    const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
    if (data?.result === 'success' && data.rates) {
      const rates = pickRates(data.rates);
      if (rates.INR) {
        latestRates = rates;
        latestDay = utcDayKey();
        ratesByDate.set(latestDay, rates);
        logger.info(`[Ads FX] live rates OK (open.er-api) INR/USD=${rates.INR} date=${data.time_last_update_utc || latestDay}`);
        return rates;
      }
    }
    errors.push('open.er-api: missing INR');
  } catch (e) {
    errors.push(`open.er-api: ${e.message}`);
  }

  try {
    const data = await fetchJson(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json'
    );
    const rates = ratesFromUsdJson(data);
    if (rates) {
      latestRates = rates;
      latestDay = utcDayKey();
      ratesByDate.set(latestDay, rates);
      logger.info(`[Ads FX] live rates OK (currency-api) INR/USD=${rates.INR}`);
      return rates;
    }
    errors.push('currency-api: missing INR');
  } catch (e) {
    errors.push(`currency-api: ${e.message}`);
  }

  try {
    const data = await fetchJson('https://api.frankfurter.app/latest?from=USD');
    const rates = pickRates(data?.rates);
    if (Object.keys(rates).length > 1) {
      latestRates = { ...EMERGENCY_UNITS_PER_USD, ...rates, USD: 1 };
      latestDay = utcDayKey();
      ratesByDate.set(latestDay, latestRates);
      logger.warn(`[Ads FX] frankfurter OK but no INR — INR uses emergency fallback ${EMERGENCY_UNITS_PER_USD.INR}`);
      return latestRates;
    }
  } catch (e) {
    errors.push(`frankfurter: ${e.message}`);
  }

  logger.warn(`[Ads FX] all live providers failed: ${errors.join('; ')}`);
  return null;
}

/** Historical rates for a calendar day (YYYY-MM-DD). */
async function fetchRatesForDate(ymd) {
  const day = isYmd(ymd) ? String(ymd) : utcDayKey();
  if (ratesByDate.has(day)) return ratesByDate.get(day);

  const today = utcDayKey();
  if (day >= today) {
    const latest = await refreshRatesFromNetwork();
    if (latest) return latest;
  }

  const errors = [];

  // fawazahmed0 dated CDN (includes INR)
  for (const url of [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.json`,
    `https://${day}.currency-api.pages.dev/v1/currencies/usd.json`,
  ]) {
    try {
      const data = await fetchJson(url);
      const rates = ratesFromUsdJson(data);
      if (rates) {
        ratesByDate.set(day, rates);
        logger.info(`[Ads FX] historical OK (${day}) INR/USD=${rates.INR}`);
        return rates;
      }
      errors.push(`${url}: missing INR`);
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }

  // Frankfurter historical (no INR)
  try {
    const data = await fetchJson(`https://api.frankfurter.app/${day}?from=USD`);
    const rates = pickRates(data?.rates);
    if (Object.keys(rates).length > 1) {
      const merged = { ...EMERGENCY_UNITS_PER_USD, ...rates, USD: 1 };
      ratesByDate.set(day, merged);
      logger.warn(`[Ads FX] historical frankfurter ${day} — INR fallback ${EMERGENCY_UNITS_PER_USD.INR}`);
      return merged;
    }
  } catch (e) {
    errors.push(`frankfurter/${day}: ${e.message}`);
  }

  // Fall back to latest live rates rather than failing the sync
  if (!latestRates || latestDay !== today) {
    await refreshRatesFromNetwork();
  }
  if (latestRates) {
    logger.warn(`[Ads FX] no historical rates for ${day}; using latest (${latestDay || 'cache'}) — ${errors.slice(0, 2).join('; ')}`);
    ratesByDate.set(day, latestRates);
    return latestRates;
  }

  logger.warn(`[Ads FX] historical fetch failed for ${day}: ${errors.join('; ')}`);
  return null;
}

async function getUnitsPerUsd(currencyCode, onDate = null) {
  const c = normalizeCurrency(currencyCode);
  if (c === 'USD') return 1;

  const day = isYmd(onDate) ? String(onDate) : utcDayKey();
  let rates = ratesByDate.get(day) || null;
  if (!rates) {
    rates = await fetchRatesForDate(day);
  }
  if (rates?.[c] > 0) return rates[c];

  if (latestRates?.[c] > 0) return latestRates[c];

  const emergency = EMERGENCY_UNITS_PER_USD[c];
  if (emergency > 0) {
    logger.warn(`[Ads FX] using emergency rate for ${c}=${emergency} (date=${day})`);
    return emergency;
  }

  logger.warn(`[Ads FX] no rate for ${c}; leaving amount unconverted`);
  return 1;
}

/**
 * Prefetch FX for many spend dates (one network call per unique day).
 * @param {string} currencyCode
 * @param {string[]} dates YMD strings
 * @returns {Promise<Map<string, number>>} date → unitsPerUsd
 */
async function preloadUnitsPerUsdForDates(currencyCode, dates = []) {
  const c = normalizeCurrency(currencyCode);
  const map = new Map();
  if (c === 'USD') {
    (dates || []).forEach((d) => map.set(String(d), 1));
    return map;
  }
  const unique = [...new Set((dates || []).map(String).filter(isYmd))];
  for (const day of unique) {
    map.set(day, await getUnitsPerUsd(c, day));
  }
  return map;
}

/**
 * @returns {{ usd: number, native: number, nativeCurrency: string, rate: number }}
 */
async function toUsd(amount, currencyCode, onDate = null) {
  const native = Number(amount) || 0;
  const nativeCurrency = normalizeCurrency(currencyCode);
  if (nativeCurrency === 'USD' || !native) {
    return { usd: native, native, nativeCurrency: nativeCurrency === 'USD' ? 'USD' : nativeCurrency, rate: 1 };
  }
  const unitsPerUsd = await getUnitsPerUsd(nativeCurrency, onDate);
  const rate = unitsPerUsd > 0 ? unitsPerUsd : 1;
  const usd = Math.round((native / rate) * 1e6) / 1e6;
  return { usd, native, nativeCurrency, rate };
}

/** Force refresh of latest rates (e.g. start of Ads sync). */
async function refreshFxRates() {
  latestDay = '';
  latestRates = null;
  return refreshRatesFromNetwork();
}

/**
 * Prefer Google Ads account-currency amount (matches Ads UI).
 * Falls back to USD `cost` when native was never stored.
 */
function adsSpendSql(alias = 's') {
  return `COALESCE(${alias}.cost_native, ${alias}.cost)`;
}

/** Currency shown for Ads spend in ROI (env override or USD). */
function adsSpendDisplayCurrency() {
  const forced = String(process.env.ADS_FORCE_CURRENCY || '').trim().toUpperCase();
  if (forced.length === 3) return forced;
  const prefer = String(process.env.ADS_ROI_SPEND_CURRENCY || '').trim().toUpperCase();
  if (prefer.length === 3) return prefer;
  return 'USD';
}

/**
 * Convert a USD amount into the ROI display currency (e.g. INR via ADS_FORCE_CURRENCY).
 * GAM warehouse earn is stored in USD; Ads native spend may be INR — align earn for ROI math.
 */
async function usdToSpendCurrency(amountUsd, onDate = null) {
  const native = Number(amountUsd) || 0;
  const cur = adsSpendDisplayCurrency();
  if (cur === 'USD' || !native) return native;
  const unitsPerUsd = await getUnitsPerUsd(cur, onDate);
  if (!(unitsPerUsd > 0)) return native;
  return Math.round(native * unitsPerUsd * 100) / 100;
}

module.exports = {
  normalizeCurrency,
  toUsd,
  getUnitsPerUsd,
  preloadUnitsPerUsdForDates,
  refreshFxRates,
  adsSpendSql,
  adsSpendDisplayCurrency,
  usdToSpendCurrency,
};
