import { useEffect, useSyncExternalStore } from 'react';
import { roiAPI } from '../api';

/**
 * Display-currency switch for the ROI screens. Amounts arrive in the Ads spend currency (e.g. INR); picking another
 * currency converts them at display time with the latest FX rates, so cards, tables and exports all follow it.
 */
export const ROI_CURRENCIES = [
  ['', 'Account currency (default)'],
  ['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['INR', 'Indian Rupee'], ['JPY', 'Japanese Yen'],
  ['CNY', 'Chinese Yuan'], ['AUD', 'Australian Dollar'], ['CAD', 'Canadian Dollar'], ['CHF', 'Swiss Franc'],
  ['SGD', 'Singapore Dollar'], ['HKD', 'Hong Kong Dollar'], ['NZD', 'New Zealand Dollar'], ['AED', 'UAE Dirham'],
  ['SAR', 'Saudi Riyal'], ['QAR', 'Qatari Riyal'], ['KWD', 'Kuwaiti Dinar'], ['SEK', 'Swedish Krona'],
  ['NOK', 'Norwegian Krone'], ['DKK', 'Danish Krone'], ['PLN', 'Polish Zloty'], ['CZK', 'Czech Koruna'],
  ['HUF', 'Hungarian Forint'], ['RON', 'Romanian Leu'], ['TRY', 'Turkish Lira'], ['RUB', 'Russian Ruble'],
  ['UAH', 'Ukrainian Hryvnia'], ['ILS', 'Israeli Shekel'], ['ZAR', 'South African Rand'], ['NGN', 'Nigerian Naira'],
  ['KES', 'Kenyan Shilling'], ['EGP', 'Egyptian Pound'], ['MAD', 'Moroccan Dirham'], ['BRL', 'Brazilian Real'],
  ['MXN', 'Mexican Peso'], ['ARS', 'Argentine Peso'], ['CLP', 'Chilean Peso'], ['COP', 'Colombian Peso'],
  ['PEN', 'Peruvian Sol'], ['KRW', 'South Korean Won'], ['THB', 'Thai Baht'], ['VND', 'Vietnamese Dong'],
  ['IDR', 'Indonesian Rupiah'], ['MYR', 'Malaysian Ringgit'], ['PHP', 'Philippine Peso'], ['TWD', 'New Taiwan Dollar'],
  ['PKR', 'Pakistani Rupee'], ['BDT', 'Bangladeshi Taka'], ['LKR', 'Sri Lankan Rupee'], ['NPR', 'Nepalese Rupee'],
];

const KEY = 'adnexus.roiCurrency';
let target = '';
try { target = localStorage.getItem(KEY) || ''; } catch { /* ignore */ }
let rates = null;
let version = 0;
const listeners = new Set();
const emit = () => { version += 1; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

let loading = null;
function loadRates() {
  if (rates || loading) return;
  loading = roiAPI.fxRates()
    .then((res) => {
      const body = res && res.data !== undefined ? res.data : res;
      if (body?.rates) { rates = body.rates; emit(); }
    })
    .catch(() => { /* keep showing the account currency */ })
    .finally(() => { loading = null; });
}

export function setRoiDisplayCurrency(code) {
  target = String(code || '').toUpperCase();
  try { localStorage.setItem(KEY, target); } catch { /* ignore */ }
  if (target) loadRates();
  emit();
}

/** { cur, rate } when amounts in `from` currency are shown converted, else null. */
function active(from) {
  const f = String(from || 'USD').trim().toUpperCase();
  if (!target || target === f || !rates || !(rates[f] > 0) || !(rates[target] > 0)) return null;
  return { cur: target, rate: rates[target] / rates[f] };
}

/** Amount in the display currency: { value, currency } for an amount in `from`. */
export function toDisplayMoney(n, from) {
  const a = active(from);
  const v = Number(n) || 0;
  return a ? { value: v * a.rate, currency: a.cur } : { value: v, currency: String(from || 'USD').trim().toUpperCase() };
}

export const convertRoi = (n, from) => toDisplayMoney(n, from).value;

export function currencySymbol(code) {
  try {
    const p = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
    return p.find((x) => x.type === 'currency')?.value || `${code} `;
  } catch { return `${code} `; }
}

/** Re-renders the caller when the display currency changes; returns the pick and a setter. */
export function useRoiDisplayCurrency() {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => { if (target) loadRates(); }, []);
  return { code: target, setCode: setRoiDisplayCurrency, ready: Boolean(rates) };
}
