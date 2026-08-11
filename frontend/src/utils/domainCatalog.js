import { readDomainName } from './filters';
import { isLikelyAppPackage, packageFromRow } from './appPackage';

/** Build admin domain-picker options — one entry per root domain name (not ad unit). */
export function catalogRowsToDomainOptions(rows = []) {
  const seen = new Set();
  const out = [];
  rows.forEach((r) => {
    const domainName = readDomainName(r);
    if (!domainName || domainName === '—') return;
    const id = domainName;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      label: domainName,
      domainName,
      appId: r.appId && r.appId !== '—' ? r.appId : '—',
      site: r.site && r.site !== '—' ? r.site : '—',
    });
  });
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** App ID (package name) picker options — MOBILE_APP_RESOLVED_ID only, never display app names. */
export function catalogRowsToAppIdOptions(rows = []) {
  const seen = new Set();
  const out = [];
  rows.forEach((r) => {
    const pkg = packageFromRow(r);
    if (!pkg) return;
    const key = pkg.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: pkg,
      label: pkg,
      appId: pkg,
      appName: r.appName && r.appName !== '—' ? r.appName : '',
    });
  });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Detect old admin lists that used ad-unit ids/labels instead of root domains. */
export function isLegacyAdUnitCatalog(domains = []) {
  return domains.some((d) => {
    const id = String(d?.id || '');
    const label = String(d?.label || '');
    return id !== d?.domainName
      || /\(\d+\)\s*$/.test(id)
      || (label.includes(' · ') && label !== d?.domainName);
  });
}

/** Normalize API picker items to root domain names only. */
export function normalizeDomainPickerOptions(items = []) {
  if (!Array.isArray(items) || !items.length) return [];
  if (!isLegacyAdUnitCatalog(items)) {
    return items.map((d) => ({
      ...d,
      id: d.domainName || d.id,
      label: d.domainName || d.label || d.id,
      domainName: d.domainName || d.id,
    }));
  }
  return catalogRowsToDomainOptions(items.map((d) => ({
    site: d.site || d.id,
    domainName: d.domainName,
    appId: d.appId,
    siteUrl: d.siteUrl,
    gamDomain: d.gamDomain,
    gamSite: d.gamSite,
  })));
}
