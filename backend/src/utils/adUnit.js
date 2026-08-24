/**
 * GAM inventory field helpers.
 *
 * Real GAM mapping (Historical / line-item report):
 *   domainName → DOMAIN (top private domain), e.g. "arenahubply.com"
 *   siteName   → SITE_NAME (site with subdomain), e.g. "m.arenahubply.com"
 *   site       → AD_UNIT_NAME (full ad unit string)
 *   appId      → MOBILE_APP_RESOLVED_ID (package name; UI label: "Package name")
 *   appName    → MOBILE_APP_NAME (display name)
 */

const WEB_TLD_RE = /\.(com|net|org|in|io|co|uk|dev|app|me|tv|info|biz|edu|gov|au|ca|de|fr|jp|sg|ae|us)(\.[a-z]{2})?$/i;

function isLikelyWebDomain(s) {
  return WEB_TLD_RE.test(String(s || '').trim());
}

function domainFromAdUnit(site) {
  if (!site) return '';
  const prefix = String(site).replace(/\s*\(\d+\)\s*$/, '').trim().split('_')[0];
  return isLikelyWebDomain(prefix) ? prefix : '';
}

/** True when ad-unit root domain matches site host root (gamisco.com_* ↔ *.gamisco.com). */
function adUnitAlignsWithSiteHost(adUnit, siteHost) {
  const auRoot = domainFromAdUnit(adUnit);
  const host = normalizeHost(siteHost);
  if (!auRoot || !host || auRoot === '—') return true;
  const hostRoot = rootDomainFromHost(host);
  if (!hostRoot) return true;
  if (auRoot.toLowerCase() === hostRoot.toLowerCase()) return true;
  if (String(adUnit || '').toLowerCase().includes(host.toLowerCase())) return true;
  return false;
}

/** Ad-unit slot suffix after domain root: "arenahubply.com_d2" → "d2". */
function siteSubFromAdUnit(adUnit) {
  if (!adUnit) return '';
  const base = String(adUnit).replace(/\s*\(\d+\)\s*$/, '').trim();
  const parts = base.split('_');
  return parts.length > 1 ? parts.slice(1).join('_') : '';
}

/** Root domain from a hostname: "m.arenahubply.com" → "arenahubply.com", "m.example.co.uk" → "example.co.uk". */
function rootDomainFromHost(host) {
  if (!host || host === '—') return '';
  const h = String(host).toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0];
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  if (parts.length >= 3 && parts[parts.length - 2] === 'co' && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** Subdomain label from hostname vs root: "m.arenahubply.com" → "m". */
function subFromHost(host, root) {
  if (!host || !root || host === root) return '';
  const h = String(host).toLowerCase();
  const suffix = `.${root}`;
  if (h.endsWith(suffix)) return h.slice(0, -suffix.length);
  return '';
}

function isLikelyAdUnitName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/\(\d+\)\s*$/.test(t)) return true;
  if (/_inter\b|_rewarded\b|_banner\b|_top\b|_side\b|_home\b|_pre\b/i.test(t)) return true;
  // "example.com_d1" — ad-unit slot, not a hostname
  if (/\.[a-z]{2,}_[a-z0-9]/i.test(t) && !/^https?:\/\//i.test(t)) return true;
  return false;
}

/** Normalize a GAM/site value to a bare hostname, or '' if it looks like an ad unit. */
function normalizeHost(v) {
  const s = cleanDim(v);
  if (!s || isLikelyAdUnitName(s)) return '';
  const host = s.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].trim();
  if (!host || isLikelyAdUnitName(host) || !isLikelyWebDomain(host)) return '';
  return host;
}

const AD_UNIT_SLOT_RE = /^(d\d+|inter|rewarded|reward|banner|top|side|home|pre|sticky|default|native|anchor|inarticle|multiplex|bottom|header|footer|skyscraper|rectangle|leaderboard|slot\d*|video|mwt)$/i;
const AD_UNIT_SLOT_TOKEN_RE = /(?:^|_)(mwt|desktop|mobile|anchor|rebid|rewarded|reward|banner|inter|sticky|native|inarticle|multiplex|skyscraper|leaderboard|rectangle)(?:_|$)/i;
/** Pure ad-format tokens (inter, banner, …) — not site subdomain labels like d2 or quiz1. */
const AD_FORMAT_TOKEN_RE = /^(inter|rewarded|reward|banner|top|side|home|pre|sticky|default|native|anchor|inarticle|multiplex|bottom|header|footer|skyscraper|rectangle|leaderboard|slot\d*|video|mwt)$/i;

/** Hostname built from ad-unit slot (d2, inter, banner…) — not a GAM SiteHosts URL. */
function isAdUnitDerivedSiteHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  const root = rootDomainFromHost(h);
  if (!root) return false;
  const sub = subFromHost(h, root);
  if (!sub) return false;
  return isLikelyAdUnitSlot(sub);
}

/** First token in an ad-unit suffix that names a site (d2_inter → d2), skipping ad-format parts. */
function siteSubdomainLabelFromSuffix(suffix) {
  const parts = String(suffix || '').split('_').filter(Boolean);
  for (const p of parts) {
    if (!AD_FORMAT_TOKEN_RE.test(p)) return p;
  }
  return '';
}

/** Ad-unit slot suffix — not a real GAM site / URL_NAME subdomain. */
function isLikelyAdUnitSlot(sub) {
  const s = String(sub || '').trim().toLowerCase();
  if (!s) return true;
  if (s.includes('_')) return true;
  if (AD_UNIT_SLOT_RE.test(s)) return true;
  if (AD_UNIT_SLOT_TOKEN_RE.test(s)) return true;
  if (/_(inter|rewarded|banner|top|pre|home|sticky)\b/i.test(s)) return true;
  return false;
}

/** GAM Site column value (SITE_NAME) — subdomain or registered site host, not ad-unit slots. */
function isGamReportSiteHost(host) {
  const h = normalizeHost(host);
  if (!h || isLikelyAdUnitName(h) || !isLikelyWebDomain(h)) return false;
  const root = rootDomainFromHost(h);
  if (!root) return false;
  const sub = subFromHost(h, root);
  if (sub && (sub.includes('_') || isLikelyAdUnitSlot(sub))) return false;
  return true;
}

/** True for real site URLs (quiz1.quizniva.com), not ad-unit slots (inter.quizniva.com). */
function isValidSiteHost(host) {
  if (!isSubdomainHost(host)) return false;
  const root = rootDomainFromHost(host);
  const sub = subFromHost(host, root);
  return Boolean(sub && !isLikelyAdUnitSlot(sub));
}

/** True when host is a subdomain of its root (e.g. quiz1.quizniva.com, not quizniva.com). */
function isSubdomainHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  const root = rootDomainFromHost(h);
  return Boolean(root && h.toLowerCase() !== root.toLowerCase());
}

/** Build full subdomain host from root + label, e.g. quizniva.com + quiz1 → quiz1.quizniva.com */
function subdomainHostFromParts(domain, sub) {
  const d = normalizeHost(domain) || String(domain || '').trim().toLowerCase();
  const raw = String(sub || '').trim();
  if (!d || !raw || d === '—' || raw === '—') return '';
  const s = (siteSubdomainLabelFromSuffix(raw) || raw).toLowerCase();
  if (!s || AD_FORMAT_TOKEN_RE.test(s)) return '';
  if (s.includes('.')) return pickSiteHost(s);
  const host = `${s}.${d}`;
  return normalizeHost(host) || (isLikelyWebDomain(host) ? host : '');
}

/** quizniva.com_quiz1 style ad unit → quiz1.quizniva.com */
function subdomainFromAdUnit(adUnit) {
  return subdomainHostFromParts(domainFromAdUnit(adUnit), siteSubFromAdUnit(adUnit));
}

/** "playblaze.in · finance2" label → finance2.playblaze.in */
function subdomainFromSiteNameLabel(siteName) {
  const m = String(siteName || '').match(/^(.+?)\s*·\s*(.+)$/);
  if (!m) return '';
  return subdomainHostFromParts(m[1].trim(), m[2].trim());
}

/** Pick the first value that is a real site host (subdomain URL), not an ad unit name. */
function pickSiteHost(...candidates) {
  for (const c of candidates) {
    const h = normalizeHost(c);
    if (h) return h;
  }
  return '';
}

const NOT_APPLICABLE_RE = /^\(not\s+applicable\)$/i;

function cleanDim(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '—' || NOT_APPLICABLE_RE.test(s)) return '';
  return s;
}

/**
 * Resolve GAM-aligned domain / site fields for a report row.
 * Prefers live GAM DOMAIN / SITE_NAME when present (from enrichReportRow).
 */
function resolveInventoryFields(adUnit, servingUrl, gamDomain, gamSite) {
  const domainFromGAM = cleanDim(gamDomain);
  const siteHost = pickSiteHost(gamSite, servingUrl);
  const urlHost = normalizeHost(servingUrl);

  if (domainFromGAM || siteHost) {
    const domainName = normalizeHost(domainFromGAM)
      || (siteHost ? rootDomainFromHost(siteHost) : '')
      || domainFromAdUnit(adUnit);
    const siteName = siteHost || normalizeHost(domainFromGAM) || '—';
    const siteSub = siteHost && domainName && domainName !== '—'
      ? (subFromHost(siteHost, domainName) || '')
      : siteSubFromAdUnit(adUnit);
    return { domainName: domainName || '—', siteName: siteName || '—', siteSub };
  }

  if (urlHost) {
    const root = rootDomainFromHost(urlHost);
    return {
      domainName: root || domainFromAdUnit(adUnit) || '—',
      siteName: urlHost,
      siteSub: subFromHost(urlHost, root) || siteSubFromAdUnit(adUnit),
    };
  }

  const domainFromUnit = domainFromAdUnit(adUnit);
  const slot = siteSubFromAdUnit(adUnit);

  if (slot) {
    return {
      domainName: domainFromUnit || '—',
      siteName: domainFromUnit ? `${domainFromUnit} · ${slot}` : slot,
      siteSub: slot,
    };
  }

  return {
    domainName: domainFromUnit || '—',
    siteName: '—',
    siteSub: '',
  };
}

/** Attach domainName, siteName, siteSub to each report row (keeps legacy siteUrl). */
function enrichReportRow(row) {
  const adUnit = row.site && row.site !== '—'
    ? row.site
    : (row.ad_unit_name || row.AD_UNIT_NAME || '');
  const gamDomain = cleanDim(row.gamDomain) || cleanDim(row.domainName) || cleanDim(row.domain);
  const { domainName, siteName, siteSub } = resolveInventoryFields(
    adUnit,
    row.siteUrl,
    gamDomain,
    row.gamSite
  );
  const resolvedHost = pickSiteHost(row.gamSite, row.siteUrl, siteName)
    || subdomainFromSiteNameLabel(siteName)
    || (() => {
      const h = normalizeHost(siteName);
      return h && isGamReportSiteHost(h) ? h : '';
    })();
  // Never persist ad-unit slot hosts (d3.*, inter.*) as SiteHosts.
  const realHost = resolvedHost && isGamReportSiteHost(resolvedHost) && !isAdUnitDerivedSiteHost(resolvedHost)
    ? resolvedHost
    : '';
  const displaySite = realHost
    || (siteName && !isLikelyAdUnitName(siteName) && !String(siteName).includes('·') ? siteName : '—');
  return {
    ...row,
    domainName,
    siteName: realHost || displaySite || '—',
    siteSub: realHost ? (siteSub || '') : '',
    gamSite: realHost || null,
    siteUrl: realHost || null,
  };
}

module.exports = {
  isLikelyWebDomain,
  isLikelyAdUnitName,
  normalizeHost,
  pickSiteHost,
  isSubdomainHost,
  isValidSiteHost,
  isGamReportSiteHost,
  isAdUnitDerivedSiteHost,
  isLikelyAdUnitSlot,
  subdomainHostFromParts,
  siteSubdomainLabelFromSuffix,
  subdomainFromAdUnit,
  subdomainFromSiteNameLabel,
  domainFromAdUnit,
  adUnitAlignsWithSiteHost,
  siteSubFromAdUnit,
  rootDomainFromHost,
  subFromHost,
  resolveInventoryFields,
  enrichReportRow,
};

