const KEY_PREFIX = 'adnexus.dashCharts';

/** Dashboard chart catalog — ids are stable for localStorage. */
export const DASH_CHARTS = [
  { id: 'trend', label: 'Revenue growth & impressions' },
  { id: 'ctr', label: 'CTR over time' },
  { id: 'clicks', label: 'Clicks trend' },
  { id: 'fill', label: 'Fill rate' },
  { id: 'unfilled', label: 'Unfilled impressions' },
  { id: 'yield', label: 'Yield quality' },
  { id: 'revenueShare', label: 'Revenue share' },
  { id: 'deviceShare', label: 'Device share' },
  { id: 'countryShare', label: 'Country share' },
  { id: 'dailyEcpm', label: 'Daily eCPM' },
  { id: 'impsDomain', label: 'Impressions by domain' },
  { id: 'impsCountry', label: 'Impressions by country' },
  { id: 'adPerformance', label: 'Ad performance' },
  { id: 'revenueEcpm', label: 'Revenue vs eCPM' },
  { id: 'topSites', label: 'Top sites' },
  { id: 'adUnitMix', label: 'Ad unit mix' },
];

const VALID = new Set(DASH_CHARTS.map((c) => c.id));

function storageKey(userId) {
  return `${KEY_PREFIX}:${userId || 'anon'}`;
}

export function loadHiddenDashCharts(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(userId)));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => VALID.has(id));
  } catch {
    return [];
  }
}

export function saveHiddenDashCharts(userId, hiddenIds) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(hiddenIds.filter((id) => VALID.has(id))));
  } catch {
    /* ignore */
  }
}

const COMPARE_KEY = 'adnexus.compareMode';

export function loadComparePrefs(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${COMPARE_KEY}:${userId || 'anon'}`));
    if (!parsed || typeof parsed !== 'object') return { mode: 'prior', startDate: '', endDate: '' };
    const mode = ['prior', 'lastWeek', 'lastMonth', 'custom'].includes(parsed.mode) ? parsed.mode : 'prior';
    return {
      mode,
      startDate: String(parsed.startDate || ''),
      endDate: String(parsed.endDate || ''),
    };
  } catch {
    return { mode: 'prior', startDate: '', endDate: '' };
  }
}

export function saveComparePrefs(userId, prefs) {
  try {
    localStorage.setItem(`${COMPARE_KEY}:${userId || 'anon'}`, JSON.stringify({
      mode: prefs.mode || 'prior',
      startDate: prefs.startDate || '',
      endDate: prefs.endDate || '',
    }));
  } catch {
    /* ignore */
  }
}
