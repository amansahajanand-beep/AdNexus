const {
  domainFromAdUnit,
  rootDomainFromHost,
  pickSiteHost,
  normalizeHost,
  enrichReportRow,
  isLikelyAdUnitName,
  isGamReportSiteHost,
  isAdUnitDerivedSiteHost,
  adUnitAlignsWithSiteHost,
} = require('./adUnit');
const {
  lookupSiteHostForAdUnit,
  lookupDomainForAdUnit,
  alignToCatalogSiteHost,
  stripAdUnitSuffix,
} = require('./inventoryCatalog');

/** Root domain — prefer resolved site host, then catalog ad-unit map (not ad-unit prefix guess). */
function readDomainName(r, ctx = null, siteUrl = '') {
  const host = siteUrl || readSiteUrl(r, ctx);
  if (host) {
    const root = rootDomainFromHost(host);
    if (root) return root;
  }
  if (ctx?.domainByAdUnit?.size) {
    const fromCatalog = lookupDomainForAdUnit(r.site, ctx.domainByAdUnit);
    if (fromCatalog) return fromCatalog;
  }
  const fromRow = normalizeHost(r.domainName)
    || normalizeHost(r.gamDomain)
    || rootDomainFromHost(pickSiteHost(r.siteUrl, r.gamSite, r.siteName));
  if (fromRow) return fromRow;
  return domainFromAdUnit(r.site) || '—';
}

/**
 * Site host for Domain User — prefer real GAM site fields, then unique catalog map.
 * Never invent hosts from ad-unit slot parsing.
 */
function readSiteUrl(r, ctx = null) {
  const siteHosts = ctx?.siteHosts || [];

  const fromFields = pickSiteHost(
    r.siteUrl,
    r.gamSite,
    r.dimensions?.url_name,
    r.dimensions?.site_name,
    r.URL_NAME,
    r.url_name,
    r.SITE_NAME,
    r.site_name
  );
  if (fromFields && !isAdUnitDerivedSiteHost(fromFields)) {
    const aligned = alignToCatalogSiteHost(fromFields, siteHosts);
    if (aligned) return aligned;
    // Keep real GAM host even when catalog list is incomplete for today.
    return fromFields;
  }

  const fromCatalog = lookupSiteHostForAdUnit(
    r.site,
    ctx?.adUnitToHost,
    ctx?.adUnitsByHost || {},
    siteHosts
  );
  if (fromCatalog) return fromCatalog;

  return '';
}

/** Site column — registered subdomain URL only (siteHosts), never ad-unit-derived hosts. */
function readSiteLabel(r, ctx = null) {
  const url = readSiteUrl(r, ctx);
  if (url) return url;

  const label = String(r.siteName || '').trim();
  if (label && label !== '—' && !isLikelyAdUnitName(label) && !isAdUnitDerivedSiteHost(label)) {
    const aligned = alignToCatalogSiteHost(label, ctx?.siteHosts || []);
    if (aligned) return aligned;
    if (isGamReportSiteHost(label)) {
      return alignToCatalogSiteHost(label, ctx?.siteHosts || []) || '';
    }
  }
  return '—';
}

function readSiteName(r, ctx = null) {
  return readSiteLabel(r, ctx);
}

/** Fill missing siteUrl only from unique catalog ad-unit↔host pairs (no host inheritance). */
function enrichRowsWithCatalogSites(rows = [], catalogRows = [], _adUnitsByHost = {}, siteHosts = []) {
  const byAdUnit = new Map();
  const candidates = new Map();
  const addCandidate = (adUnit, host) => {
    const canonical = alignToCatalogSiteHost(host, siteHosts);
    if (!canonical || !adUnit || adUnit === '—') return;
    if (!adUnitAlignsWithSiteHost(adUnit, canonical)) return;
    [adUnit, stripAdUnitSuffix(adUnit)].forEach((key) => {
      const k = String(key || '').trim().toLowerCase();
      if (!k) return;
      if (!candidates.has(k)) candidates.set(k, new Set());
      candidates.get(k).add(canonical);
    });
  };
  catalogRows.forEach((c) => {
    const host = pickSiteHost(c.siteUrl, c.gamSite, c.siteName);
    if (!host || !c.site || c.site === '—') return;
    addCandidate(c.site, host);
  });
  candidates.forEach((hosts, key) => {
    if (hosts.size === 1) byAdUnit.set(key, [...hosts][0]);
  });
  if (!byAdUnit.size) return rows;

  return rows.map((r) => {
    const existing = readSiteUrl(r, { siteHosts, adUnitToHost: byAdUnit });
    if (existing) return r;
    const stripped = stripAdUnitSuffix(r.site);
    const host = byAdUnit.get(String(r.site || '').trim().toLowerCase())
      || (stripped ? byAdUnit.get(stripped.toLowerCase()) : '');
    if (!host || !adUnitAlignsWithSiteHost(r.site, host)) return r;
    const domainName = rootDomainFromHost(host) || r.domainName;
    return enrichReportRow({
      ...r,
      siteUrl: host,
      gamSite: host,
      siteName: host,
      domainName,
      gamDomain: domainName,
    });
  });
}

/** Roll detailed GAM rows into one record per App ID + domain + site. */
function aggregateDomainUserRows(rows = [], ctx = null) {
  const map = {};
  rows.forEach((r) => {
    const siteUrl = readSiteUrl(r, ctx);
    const siteName = readSiteLabel(r, ctx);
    const domainName = readDomainName(r, ctx, siteUrl);
    const key = `${r.appId}|${domainName}|${siteUrl || siteName}`;
    if (!map[key]) {
      map[key] = {
        appId: r.appId,
        domainName,
        siteName,
        siteUrl: siteUrl || '',
        revenue: 0,
        impression: 0,
        fillSum: 0,
        ctrSum: 0,
        n: 0,
      };
    }
    const m = map[key];
    if (!m.siteUrl && siteUrl) m.siteUrl = siteUrl;
    if (m.siteName === '—' && siteName !== '—') m.siteName = siteName;
    if (m.domainName === '—' && domainName !== '—') m.domainName = domainName;
    m.revenue += Number(r.revenue) || 0;
    m.impression += Number(r.impression ?? r.impressions) || 0;
    m.fillSum += r.fillRate || 0;
    m.ctrSum += r.ctr || 0;
    m.n += 1;
  });

  return Object.values(map).map((m) => {
    const siteUrl = m.siteUrl || readSiteUrl(m, ctx);
    const siteName = siteUrl || '—';
    const domainName = siteUrl
      ? (rootDomainFromHost(siteUrl) || m.domainName)
      : m.domainName;
    return {
      appId: m.appId,
      domainName,
      siteName,
      siteUrl: siteUrl || '',
      revenue: +m.revenue.toFixed(2),
      impression: m.impression,
      fillRate: m.n ? +(m.fillSum / m.n).toFixed(2) : 0,
      ctr: m.n ? +(m.ctrSum / m.n).toFixed(2) : 0,
    };
  });
}

function filterDomainUserRows(rows = [], search = '') {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((d) =>
    [d.appId, d.domainName, d.siteName, d.siteUrl].some((v) => String(v || '').toLowerCase().includes(q))
  );
}

function summarizeDomainUserRows(rows = []) {
  const totalRevenue = +rows.reduce((a, r) => a + (Number(r.revenue) || 0), 0).toFixed(2);
  const impressions = rows.reduce((a, r) => a + (Number(r.impression ?? r.impressions) || 0), 0);
  const uniqueRoots = new Set(
    rows.map((r) => r.domainName).filter((d) => d && d !== '—')
  );
  return {
    totalDomains: uniqueRoots.size || rows.length,
    totalRows: rows.length,
    totalRevenue,
    impressions,
  };
}

module.exports = {
  readDomainName,
  readSiteUrl,
  readSiteName,
  readSiteLabel,
  enrichRowsWithCatalogSites,
  aggregateDomainUserRows,
  filterDomainUserRows,
  summarizeDomainUserRows,
};
