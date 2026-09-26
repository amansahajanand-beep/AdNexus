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

export const PRODUCT_LIST = [PRODUCTS.gam, PRODUCTS.admob, PRODUCTS.adsense];

const STORAGE_KEY = 'adnexus.activeProduct';

export function readStoredProduct() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && PRODUCTS[v]) return v;
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
  { to: '/help', label: 'Help', page: 'help', always: true },
];

export const ADMOB_NAV_ITEMS = [
  { to: '/admob/dashboard', label: 'Dashboard', page: 'admob-dashboard' },
  { to: '/admob/reporting', label: 'Reporting', page: 'admob-reporting' },
  { to: '/admin', label: 'Admin', page: 'admin', adminOnly: true },
  { to: '/help', label: 'Help', page: 'help', always: true },
];

export const ADSENSE_NAV_ITEMS = [
  { to: '/adsense/dashboard', label: 'Dashboard', page: 'adsense-dashboard' },
  { to: '/adsense/sites', label: 'Sites', page: 'adsense-sites' },
  { to: '/adsense/ad-units', label: 'Ad units', page: 'adsense-ad-units' },
  { to: '/adsense/reporting', label: 'Reporting', page: 'adsense-reporting' },
  { to: '/admin', label: 'Admin', page: 'admin', adminOnly: true },
  { to: '/help', label: 'Help', page: 'help', always: true },
];

export function navItemsForProduct(productId) {
  if (productId === 'admob') return ADMOB_NAV_ITEMS;
  if (productId === 'adsense') return ADSENSE_NAV_ITEMS;
  return GAM_NAV_ITEMS;
}
