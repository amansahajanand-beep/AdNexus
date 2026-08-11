/** GAM App ID = store package/bundle id — not numeric GAM internal ids or display names. */

export function isGamInternalAppId(value) {
  const s = String(value ?? '').trim();
  return Boolean(s && /^\d+$/.test(s));
}

export function isLikelyAppPackage(value) {
  const s = String(value ?? '').trim();
  if (!s || s === '—') return false;
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (isGamInternalAppId(s)) return false;
  return s.length >= 1 && s.length <= 255;
}

export function packageFromRow(row = {}) {
  const pkg = row.appPackage && row.appPackage !== '—' ? row.appPackage : '';
  if (isLikelyAppPackage(pkg)) return pkg;
  if (isLikelyAppPackage(row.appId)) return row.appId;
  return '';
}
