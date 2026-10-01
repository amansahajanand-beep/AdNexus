/** Multi-product workspace: GAM | AdMob | AdSense */

export const PRODUCTS = {
  gam: {
    id: 'gam',
    label: 'GAM',
    fullLabel: 'Google Ad Manager',
    shortDesc: 'Network & programmatic',
    home: '/dashboard',
    accentVar: '--product-gam',
  },
  admob: {
    id: 'admob',
    label: 'AdMob',
    fullLabel: 'Google AdMob',
    shortDesc: 'Apps & mediation',
    home: '/admob/dashboard',
    accentVar: '--product-admob',
  },
  adsense: {
    id: 'adsense',
    label: 'AdSense',
    fullLabel: 'Google AdSense',
    shortDesc: 'Sites & content',
    home: '/adsense/dashboard',
    accentVar: '--product-adsense',
  },
};

/** Set to false to hide AdSense routes and its switcher entry. */
export const ADSENSE_ENABLED = true;

export const PRODUCT_LIST = ADSENSE_ENABLED
  ? [PRODUCTS.gam, PRODUCTS.admob, PRODUCTS.adsense]
  : [PRODUCTS.gam, PRODUCTS.admob];

const STORAGE_KEY = 'adnexus.activeProduct';

export function readStoredProduct() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && PRODUCT_LIST.some((p) => p.id === v)) return v;
  } catch {
    /* ignore */
  }
  return 'gam';
}

export function writeStoredProduct(productId) {
  try {
    if (PRODUCTS[productId]) localStorage.setItem(STORAGE_KEY, productId);
  } catch {
    /* ignore */
  }
}

/** Infer product from pathname (route is source of truth while browsing). */
export function productFromPath(pathname = '') {
  const p = String(pathname || '');
  if (p.startsWith('/admob')) return 'admob';
  if (p.startsWith('/adsense')) return 'adsense';
  return 'gam';
}

/**
 * Active product for the shell. Shared routes (/admin, /help) keep the last product
 * so switching pages inside Admin does not snap the switcher back to GAM.
 */
export function resolveActiveProduct(pathname = '') {
  const path = String(pathname || '').split('?')[0];
  if (path === '/admin' || path === '/help') {
    return readStoredProduct();
  }
  return productFromPath(path);
}

export function getProduct(productId) {
  return PRODUCTS[productId] || PRODUCTS.gam;
}

export const GAM_NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', page: 'dashboard' },
  { to: '/reporting', label: 'Reporting', page: 'reporting' },
  { to: '/roi', label: 'ROI', page: 'roi' },
  { to: '/my-ads', label: 'Google Ads', page: 'my-ads' },
  { to: '/presets', label: 'Presets', page: 'presets' },
  { to: '/admin', label: 'Admin', page: 'admin', adminOnly: true },
  { to: '/domain-user', label: 'Domain User', page: 'domain-user' },
  { to: '/feedback', label: 'Feedback & Issues', page: 'feedback', always: true },
  { to: '/help', label: 'Help', page: 'help', always: true },
];

export const ADMOB_NAV_ITEMS = [
  { to: '/admob/dashboard', label: 'Dashboard', page: 'admob-dashboard' },
  { to: '/admob/reporting', label: 'Reporting', page: 'admob-reporting' },
  { to: '/admob/presets', label: 'Presets', page: 'admob-presets', pageAny: ['admob-dashboard', 'admob-reporting'] },
  { to: '/admob/roi', label: 'ROI', page: 'admob-roi', adminOnly: true },
  { to: '/admin', label: 'Admin', page: 'admin', adminOnly: true },
  { to: '/help', label: 'Help', page: 'help', always: true },
];

export const ADSENSE_NAV_ITEMS = [
  { to: '/adsense/dashboard', label: 'Dashboard', page: 'adsense-dashboard' },
  { to: '/adsense/reporting', label: 'Reporting', page: 'adsense-reporting' },
  { to: '/adsense/roi', label: 'ROI', page: 'adsense-roi', adminOnly: true },
  { to: '/adsense/presets', label: 'Presets', page: 'adsense-presets', pageAny: ['adsense-dashboard', 'adsense-reporting'] },
  { to: '/admin', label: 'Admin', page: 'admin', adminOnly: true },
  { to: '/help', label: 'Help', page: 'help', always: true },
];

export function navItemsForProduct(productId) {
  if (productId === 'admob') return ADMOB_NAV_ITEMS;
  if (productId === 'adsense') return ADSENSE_NAV_ITEMS;
  return GAM_NAV_ITEMS;
}
