const THEME_KEY = 'adnexus.theme';

export function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* ignore */
  }
  return 'light';
}

export function isDarkTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/** Apply theme to <html> and persist. */
export function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#0B1220' : '#0f172a');
  }
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}

export function toggleTheme() {
  return applyTheme(isDarkTheme() ? 'light' : 'dark');
}

/** Call once on boot (also mirrored by inline script in index.html). */
export function initTheme() {
  return applyTheme(readStoredTheme());
}
