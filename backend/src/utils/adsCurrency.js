/**
 * Convert Google Ads account-currency amounts → USD using a live FX API.
 * Rates are fetched from the network (cached for the calendar day) so daily
 * market moves apply on the next sync without editing .env.
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

let cachedRates = null; // { USD: 1, INR: 87.2, ... } — foreign units per 1 USD
let cachedDay = ''; // YYYY-MM-DD (UTC) when rates were fetched

function normalizeCurrency(code) {
  const c = String(code || 'USD').trim().toUpperCase();
  return c.length === 3 ? c : 'USD';
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function cacheValid() {
  return cachedRates && cachedDay === utcDayKey();
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

/**
 * Live providers (INR included). Values = how many units of that currency = 1 USD.
 */
async function refreshRatesFromNetwork() {
  const errors = [];

  // 1) open.er-api.com — free, includes INR
  try {
    const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
    if (data?.result === 'success' && data.rates) {
      const rates = pickRates(data.rates);
      if (rates.INR) {
        cachedRates = rates;
        cachedDay = utcDayKey();
        logger.info(`[Ads FX] live rates OK (open.er-api) INR/USD=${rates.INR} date=${data.time_last_update_utc || cachedDay}`);
        return rates;
      }
    }
    errors.push('open.er-api: missing INR');
  } catch (e) {
    errors.push(`open.er-api: ${e.message}`);
  }

  // 2) fawazahmed0 currency-api CDN — free, includes INR (usd.inr = INR per 1 USD)
  try {
    const data = await fetchJson(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json'
    );
    const usd = data?.usd || {};
    const rates = { USD: 1 };
    Object.entries(usd).forEach(([code, val]) => {
      const c = String(code || '').toUpperCase();
      const n = Number(val);
      if (c.length === 3 && n > 0) rates[c] = n;
    });
    if (rates.INR) {
      cachedRates = rates;
      cachedDay = utcDayKey();
      logger.info(`[Ads FX] live rates OK (currency-api) INR/USD=${rates.INR}`);
      return rates;
    }
    errors.push('currency-api: missing INR');
  } catch (e) {
    errors.push(`currency-api: ${e.message}`);
  }

  // 3) Frankfurter (ECB) — no INR, but useful for EUR/GBP etc.
  try {
    const data = await fetchJson('https://api.frankfurter.app/latest?from=USD');
    const rates = pickRates(data?.rates);
    if (Object.keys(rates).length > 1) {
      cachedRates = { ...EMERGENCY_UNITS_PER_USD, ...rates, USD: 1 };
      cachedDay = utcDayKey();
      logger.warn(`[Ads FX] frankfurter OK but no INR — INR uses emergency fallback ${EMERGENCY_UNITS_PER_USD.INR}`);
      return cachedRates;
    }
  } catch (e) {
    errors.push(`frankfurter: ${e.message}`);
  }

  logger.warn(`[Ads FX] all live providers failed: ${errors.join('; ')}`);
  return null;
}

async function getUnitsPerUsd(currencyCode) {
  const c = normalizeCurrency(currencyCode);
  if (c === 'USD') return 1;

  if (!cacheValid()) {
    await refreshRatesFromNetwork();
  }
  if (cachedRates?.[c] > 0) return cachedRates[c];

  // Stale cache from a previous day still better than emergency if present
  if (cachedRates?.[c] > 0) return cachedRates[c];

  const emergency = EMERGENCY_UNITS_PER_USD[c];
  if (emergency > 0) {
    logger.warn(`[Ads FX] using emergency rate for ${c}=${emergency} (live API down)`);
    return emergency;
  }

  logger.warn(`[Ads FX] no rate for ${c}; leaving amount unconverted`);
  return 1;
}

/**
 * @returns {{ usd: number, native: number, nativeCurrency: string, rate: number }}
 */
async function toUsd(amount, currencyCode) {
  const native = Number(amount) || 0;
  const nativeCurrency = normalizeCurrency(currencyCode);
  if (nativeCurrency === 'USD' || !native) {
    return { usd: native, native, nativeCurrency: nativeCurrency === 'USD' ? 'USD' : nativeCurrency, rate: 1 };
  }
  const unitsPerUsd = await getUnitsPerUsd(nativeCurrency);
  const rate = unitsPerUsd > 0 ? unitsPerUsd : 1;
  const usd = Math.round((native / rate) * 1e6) / 1e6;
  return { usd, native, nativeCurrency, rate };
}

/** Force refresh (e.g. start of Ads sync). */
async function refreshFxRates() {
  cachedDay = '';
  return refreshRatesFromNetwork();
}

module.exports = {
  normalizeCurrency,
  toUsd,
  getUnitsPerUsd,
  refreshFxRates,
};
