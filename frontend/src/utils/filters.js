// Shared filter helpers for the report pages (Dashboard + Reporting).
//
// GAM-aligned row fields (set by backend enrichReportRow):
//   domainName → GAM DOMAIN (top private domain), e.g. "arenahubply.com"
//   siteName   → GAM Site / host with subdomain, e.g. "m.arenahubply.com"
//   site       → GAM AD_UNIT_NAME (full ad unit)
//   appId      → GAM MOBILE_APP_RESOLVED_ID (any package id format; UI label: "App ID")
//   appName    → GAM MOBILE_APP_NAME (display name — not used in picker lists)

import { packageFromRow } from './appPackage';

const WEB_TLD_RE = /\.(com|net|org|in|io|co|uk|dev|app|me|tv|info|biz|edu|gov|au|ca|de|fr|jp|sg|ae|us)(\.[a-z]{2})?$/i;

function isLikelyWebDomain(s) {
  return WEB_TLD_RE.test(String(s || '').trim());
}

function domainFromAdUnit(site) {
  if (!site) return '';
  const prefix = String(site).replace(/\s*\(\d+\)\s*$/, '').trim().split('_')[0];
  return isLikelyWebDomain(prefix) ? prefix : '';
}

/** Strip subdomains: "m.arenahubply.com" → "arenahubply.com", "m.example.co.uk" → "example.co.uk". */
function rootDomainFromHost(host) {
  if (!host) return '';
  const h = String(host).toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0];
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  if (parts.length >= 3 && parts[parts.length - 2] === 'co' && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function isLikelyAdUnitName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/\(\d+\)\s*$/.test(t)) return true;
  if (/_inter\b|_rewarded\b|_banner\b|_top\b|_side\b|_home\b|_pre\b/i.test(t)) return true;
  if (/\.[a-z]{2,}_[a-z0-9]/i.test(t) && !/^https?:\/\//i.test(t)) return true;
  return false;
}

const NOT_APPLICABLE_RE = /^\(not\s+applicable\)$/i;

function cleanVal(v) {
  if (!v || v === '—' || NOT_APPLICABLE_RE.test(v)) return '';
  return v;
}

function normalizeHostVal(v) {
  const c = cleanVal(v);
  if (!c || isLikelyAdUnitName(c)) return '';
  const host = c.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].trim();
  if (!host || isLikelyAdUnitName(host) || !isLikelyWebDomain(host)) return '';
  return host;
}

function readDomainName(r) {
  const d = normalizeHostVal(r.domainName) || rootDomainFromHost(normalizeHostVal(r.siteUrl) || normalizeHostVal(r.siteName));
  return d || '—';
}

function subLabelFromHost(host) {
  const h = normalizeHostVal(host);
  if (!h) return '';
  const root = rootDomainFromHost(h);
  if (!root || h.toLowerCase() === root.toLowerCase()) return '';
  return h.slice(0, -(root.length + 1));
}

/** "playblaze.in · finance2" → finance2.playblaze.in */
function subdomainFromSiteNameLabel(siteName) {
  const m = String(siteName || '').match(/^(.+?)\s*·\s*(.+)$/);
  if (!m) return '';
  const domain = m[1].trim();
  const sub = m[2].trim();
  if (!domain || !sub) return '';
  const host = `${sub}.${domain}`.toLowerCase();
  const normalized = normalizeHostVal(host);
  return normalized || host;
}

function subdomainFromAdUnit(adUnit) {
  const domain = domainFromAdUnit(adUnit);
  const base = String(adUnit || '').replace(/\s*\(\d+\)\s*$/, '').trim();
  const parts = base.split('_');
  const slot = parts.length > 1 ? parts.slice(1).join('_') : '';
  if (!domain || !slot) return '';
  const host = `${slot}.${domain}`.toLowerCase();
  const normalized = normalizeHostVal(host);
  return normalized || (isLikelyWebDomain(host) ? host : '');
}

/** Canonical site host for display & Site filter (registered SiteHosts only). */
export function resolveSiteHost(row) {
  // Prefer real GAM SiteHosts fields — never invent hosts from ad-unit slots (d3/inter).
  const preferred = [
    normalizeHostVal(row.siteUrl),
    normalizeHostVal(row.gamSite),
    subdomainFromSiteNameLabel(row.siteName),
    normalizeHostVal(row.siteName),
  ].filter(Boolean);
  for (const h of preferred) {
    if (isGamReportSiteHost(h)) return h;
  }
  return '';
}

/** All site host strings for cascade matching — real site fields only. */
function siteHostsForRow(row) {
  const hosts = new Set();
  const add = (v) => {
    if (!v || v === '—') return;
    const norm = normalizeHostVal(v);
    if (norm) hosts.add(norm);
    else hosts.add(String(v).trim());
  };
  add(resolveSiteHost(row));
  add(row.siteUrl);
  add(row.gamSite);
  add(row.siteName);
  add(row.dimensions?.url_name);
  add(row.dimensions?.site_name);
  add(subdomainFromSiteNameLabel(row.siteName));
  return hosts;
}

function rowMatchesSite(row, siteVals) {
  if (!siteVals.length) return true;
  const rowHosts = siteHostsForRow(row);
  return siteVals.some((sel) => {
    const raw = String(sel).trim();
    const selNorm = normalizeHostVal(raw) || raw.toLowerCase();
    if (rowHosts.has(raw) || rowHosts.has(selNorm)) return true;
    for (const h of rowHosts) {
      if (normalizeHostVal(h) === selNorm) return true;
    }
    return false;
  });
}

const AD_UNIT_SLOT_RE = /^(d\d+|inter|rewarded|reward|banner|top|side|home|pre|sticky|default|native|anchor|inarticle|multiplex|bottom|header|footer|skyscraper|rectangle|leaderboard|slot\d*|video|mwt)$/i;
const AD_UNIT_SLOT_TOKEN_RE = /(?:^|_)(mwt|desktop|mobile|anchor|rebid|rewarded|reward|banner|inter|sticky|native|inarticle|multiplex|skyscraper|leaderboard|rectangle)(?:_|$)/i;

function isLikelyAdUnitSlot(sub) {
  const s = String(sub || '').trim().toLowerCase();
  if (!s) return true;
  if (s.includes('_')) return true;
  if (AD_UNIT_SLOT_RE.test(s)) return true;
  if (AD_UNIT_SLOT_TOKEN_RE.test(s)) return true;
  return false;
}

function isSubdomainHost(host) {
  const h = normalizeHostVal(host);
  if (!h) return false;
  const root = rootDomainFromHost(h);
  return Boolean(root && h.toLowerCase() !== root.toLowerCase());
}

function isGamReportSiteHost(host) {
  const h = normalizeHostVal(host);
  if (!h || isLikelyAdUnitName(h) || !isLikelyWebDomain(h)) return false;
  const root = rootDomainFromHost(h);
  if (!root) return false;
  const sub = subLabelFromHost(h);
  if (sub && (sub.includes('_') || isLikelyAdUnitSlot(sub))) return false;
  return true;
}

function isValidSiteHost(host) {
  if (!isSubdomainHost(host)) return false;
  const sub = subLabelFromHost(host);
  return Boolean(sub && !isLikelyAdUnitSlot(sub) && !isLikelyAdUnitName(host));
}

function readSiteName(r) {
  const host = resolveSiteHost(r);
  // Site column = registered SiteHosts only (quiz1.example.com), never d3./inter. ad-unit slots.
  return host && isGamReportSiteHost(host) ? host : '—';
}

export function validSiteHostsOnly(hosts = []) {
  return hosts.filter((h) => isGamReportSiteHost(h));
}

export const FILTER_FIELDS = {
  domain: readDomainName,
  site: readSiteName,
  adUnit: (r) => r.site,
  app: (r) => packageFromRow(r),
};

const SELECTION_KEYS = {
  domain: 'domain',
  site: 'site',
  adUnit: 'adUnit',
  app: 'app',
};

function rowMatches(row, selections, exclude) {
  return Object.keys(FILTER_FIELDS).every((key) => {
    if (key === exclude) return true;
    const vals = selections[key] || [];
    if (vals.length === 0) return true;
    if (key === 'site') return rowMatchesSite(row, vals);
    return vals.includes(FILTER_FIELDS[key](row));
  });
}

export function optionsFor(catalog, selections, field) {
  const read = FILTER_FIELDS[field];
  const set = new Set();
  // Domain is the top-level filter — always show full list regardless of child selections.
  const effectiveSelections = field === 'domain' ? {} : selections;
  catalog.forEach((row) => {
    if (!rowMatches(row, effectiveSelections, field)) return;
    const v = read(row);
    if (!v || v === '—') return;
    if (field === 'site' && !isGamReportSiteHost(v)) return;
    set.add(v);
  });
  return Array.from(set).sort();
}

/** Keep only values still valid for a field — never auto-add selections. */
export function pruneSelection(catalog, selections, field) {
  const key = SELECTION_KEYS[field];
  const current = selections[key] || [];
  if (!current.length || !catalog.length) return current;
  const allowed = new Set(optionsFor(catalog, selections, field));
  return current.filter((v) => allowed.has(v));
}

/**
 * When a parent inventory filter changes, drop invalid child picks only.
 * Domain ↔ Site are independent: changing domain does not auto-select site.
 */
export function pruneAfterFieldChange(catalog, selections, changedField) {
  const next = { ...selections };
  if (changedField === 'domain') {
    next.site = pruneSelection(catalog, next, 'site');
    next.adUnit = pruneSelection(catalog, next, 'adUnit');
    next.app = pruneSelection(catalog, next, 'app');
  } else if (changedField === 'site') {
    next.adUnit = pruneSelection(catalog, next, 'adUnit');
    next.app = pruneSelection(catalog, next, 'app');
  } else if (changedField === 'adUnit') {
    next.app = pruneSelection(catalog, next, 'app');
  }
  return next;
}

export { domainFromAdUnit, readDomainName, readSiteName, rootDomainFromHost };
