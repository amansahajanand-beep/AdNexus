const {
  resolveAppFields,
  appPackageForPicker,
} = require('./appIdentity');
const {
  domainFromAdUnit,
  enrichReportRow,
  resolveInventoryFields,
  pickSiteHost,
  normalizeHost,
  isSubdomainHost,
  isValidSiteHost,
  isGamReportSiteHost,
  isAdUnitDerivedSiteHost,
  rootDomainFromHost,
  subdomainHostFromParts,
  subdomainFromAdUnit,
  subdomainFromSiteNameLabel,
  adUnitAlignsWithSiteHost,
} = require('./adUnit');

/** Reuse rows from any cached full report to avoid extra GAM jobs. */
const CATALOG_CACHE_KEY = 'filter_catalog_inventory_v25';

function findCachedInventoryRows(cache) {
  if (!cache?.keys) return null;
  // Prefer specifically-fetched catalog (has URL_NAME subdomain data)
  const catalog = cache.get(CATALOG_CACHE_KEY);
  if (catalog?.rows?.length) return catalog.rows;
  if (Array.isArray(catalog) && catalog.length) return catalog;
  // Fallback: use any cached full report rows (domain list still works)
  const keys = cache.keys();
  for (const key of keys) {
    if (!key.startsWith('report_') || !key.includes('full')) continue;
    const data = cache.get(key);
    if (data?.rows?.length) return data.rows;
  }
  return null;
}

/** Resolve root domain for admin picker (never use ad-unit id as label). */
function readRootDomain(row) {
  if (row.domainName && row.domainName !== '—') return row.domainName;
  const inv = resolveInventoryFields(row.site, row.siteUrl, row.gamDomain, row.gamSite);
  if (inv.domainName && inv.domainName !== '—') return inv.domainName;
  const fromUnit = domainFromAdUnit(row.site);
  return fromUnit || '';
}

/** Build admin domain-picker options — one entry per root domain name (not ad unit). */
function rowsToDomainOptions(rows = []) {
  const seen = new Set();
  const out = [];
  rows.forEach((r) => {
    const domainName = readRootDomain(r);
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

function isLegacyAdUnitCatalog(domains = []) {
  return domains.some((d) => {
    const id = String(d?.id || '');
    const label = String(d?.label || '');
    return id !== d?.domainName
      || /\(\d+\)\s*$/.test(id)
      || (label.includes(' · ') && label !== d?.domainName);
  });
}

/** Dedupe rows to one row per unique inventory combination for filter dropdowns. */
function dedupeCatalogRows(rows = []) {
  const map = new Map();
  rows.forEach((r) => {
    const key = `${r.appId}|${r.domainName}|${r.siteName}|${r.site}`;
    if (!map.has(key)) map.set(key, r);
  });
  return Array.from(map.values());
}

const NOT_APPLICABLE_RE = /^\(not\s+applicable\)$/i;
function cleanGamStr(v) {
  const s = String(v ?? '').trim();
  return !s || NOT_APPLICABLE_RE.test(s) ? '' : s;
}

/** Map GAM ad-unit display name → inventory id (with/without numeric suffix). */
function buildAdUnitNameToIdMap(units = []) {
  const map = {};
  units.forEach((u) => {
    if (!u?.name || !u?.id) return;
    map[u.name] = u.id;
    const stripped = String(u.name).replace(/\s*\(\d+\)\s*$/, '').trim();
    if (stripped) map[stripped] = u.id;
  });
  return map;
}

/** Resolve domain/site fields from a raw GAM report row + inventory site map. */
function mapGamRowInventory(r, siteMap = {}, adUnitByName = {}) {
  const adUnit = cleanGamStr(r['Dimension.AD_UNIT_NAME']) || '—';
  let adUnitId = cleanGamStr(r['Dimension.AD_UNIT_ID']);
  if (!adUnitId && adUnit !== '—') {
    const stripped = adUnit.replace(/\s*\(\d+\)\s*$/, '').trim();
    adUnitId = adUnitByName[adUnit] || adUnitByName[stripped] || '';
  }
  const gamDomain = cleanGamStr(r['Dimension.DOMAIN']);
  const urlName = cleanGamStr(r['Dimension.URL_NAME']);
  const siteNameDim = cleanGamStr(r['Dimension.SITE_NAME']);
  const inventorySite = adUnitId ? (siteMap[adUnitId] || '') : '';
  // URL_NAME / SITE_NAME beat inventory names — hierarchy often stores ad-unit labels, not hosts.
  // Reject ad-unit slot hosts (d3.*, inter.*, banner.*) — Site column needs real SiteHosts.
  const pickRealSiteHost = (...cands) => {
    for (const c of cands) {
      const h = pickSiteHost(c);
      if (h && isGamReportSiteHost(h) && !isAdUnitDerivedSiteHost(h)) return h;
    }
    return '';
  };
  const gamSiteRaw = pickRealSiteHost(urlName, siteNameDim, inventorySite);
  const gamSite = (gamSiteRaw && adUnit !== '—' && !adUnitAlignsWithSiteHost(adUnit, gamSiteRaw))
    ? (() => {
      const alt = pickRealSiteHost(urlName, siteNameDim);
      return alt && adUnitAlignsWithSiteHost(adUnit, alt) ? alt : '';
    })()
    : gamSiteRaw;
  return {
    adUnit,
    adUnitId,
    gamDomain: gamDomain || '',
    gamSite,
    siteUrl: gamSite || null,
  };
}

function enrichCatalogRow(r, siteMap = {}, adUnitByName = {}) {
  const inv = mapGamRowInventory(r, siteMap, adUnitByName);
  const numOr0 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const intOr0 = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
  const impression = intOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS']);
  const revenue = +(numOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE']) / 1e6).toFixed(2);
  const clicks = intOr0(r['Column.TOTAL_LINE_ITEM_LEVEL_CLICKS']);
  const unfilled = intOr0(r['Column.TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS']);
  const ctr = impression > 0 ? +((clicks / impression) * 100).toFixed(2) : 0;
  const fillRate = (impression + unfilled) > 0 ? +((impression / (impression + unfilled)) * 100).toFixed(2) : 0;
  return enrichReportRow({
    date: r['Dimension.DATE'] || '—',
    ...resolveAppFields({ raw: r }),
    site: inv.adUnit,
    adUnitId: inv.adUnitId || null,
    gamDomain: inv.gamDomain,
    gamSite: inv.gamSite,
    siteUrl: inv.siteUrl,
    revenue,
    impression,
    clicks,
    ctr,
    fillRate,
  });
}

/** Apply a resolved GAM site host onto a catalog row (re-runs enrichReportRow). */
function applyHostToCatalogRow(row, host) {
  if (!host || !row) return row;
  const updated = enrichReportRow({ ...row, siteUrl: host, gamSite: host });
  Object.assign(row, updated);
  return row;
}

/** Link ad units to GAM site hosts from URL scan rows (AD_UNIT_NAME + URL_NAME / SITE_NAME). */
function mergeUrlScanIntoCatalog(rows = [], rawUrlScan = [], adUnitByName = {}) {
  if (!rawUrlScan.length || !rows.length) return rows;
  const byAdUnit = new Map();
  rows.forEach((r) => {
    if (r.site && r.site !== '—') byAdUnit.set(r.site, r);
    if (r.adUnitId) byAdUnit.set(String(r.adUnitId), r);
  });
  rawUrlScan.forEach((r) => {
    const adUnit = cleanGamStr(r['Dimension.AD_UNIT_NAME']);
    let adUnitId = cleanGamStr(r['Dimension.AD_UNIT_ID']);
    if (!adUnitId && adUnit) {
      const stripped = adUnit.replace(/\s*\(\d+\)\s*$/, '').trim();
      adUnitId = adUnitByName[adUnit] || adUnitByName[stripped] || '';
    }
    const host = hostFromGamReportRow(r);
    if (!host) return;
    const keys = [adUnit, adUnitId].filter(Boolean);
    keys.forEach((key) => {
      const existing = byAdUnit.get(key);
      if (existing) applyHostToCatalogRow(existing, host);
    });
  });
  return rows;
}

function stripAdUnitSuffix(adUnit) {
  return String(adUnit || '').replace(/\s*\(\d+\)\s*$/, '').trim();
}

/** Ad unit name → canonical site host (only registered siteHosts / adUnitsByHost keys). */
function buildAdUnitToSiteHostMap(adUnitsByHost = {}, siteHosts = []) {
  const allowed = siteHosts.length
    ? new Set(siteHosts.map((s) => String(s).toLowerCase()))
    : null;
  const map = new Map();
  const add = (adUnit, host) => {
    const canonical = pickSiteHost(host);
    if (!canonical || !adUnit || adUnit === '—') return;
    if (!adUnitAlignsWithSiteHost(adUnit, canonical)) return;
    if (isAdUnitDerivedSiteHost(canonical)) return;
    if (allowed && !allowed.has(canonical.toLowerCase())) return;
    const stripped = stripAdUnitSuffix(adUnit);
    [adUnit, stripped].forEach((key) => {
      const k = String(key || '').trim().toLowerCase();
      if (k && !map.has(k)) map.set(k, canonical);
    });
  };
  Object.entries(adUnitsByHost).forEach(([host, units]) => {
    (units || []).forEach((au) => add(au, host));
  });
  return map;
}

function lookupSiteHostForAdUnit(adUnit, adUnitToHost = new Map(), adUnitsByHost = {}, siteHosts = []) {
  if (!adUnit || adUnit === '—') return '';
  const stripped = stripAdUnitSuffix(adUnit).toLowerCase();
  const raw = String(adUnit).trim().toLowerCase();
  const fromMap = adUnitToHost.get(raw) || adUnitToHost.get(stripped);
  if (fromMap) return fromMap;

  const allowed = siteHosts.length
    ? new Set(siteHosts.map((s) => String(s).toLowerCase()))
    : null;
  for (const [host, units] of Object.entries(adUnitsByHost)) {
    const canonical = pickSiteHost(host);
    if (!canonical || isAdUnitDerivedSiteHost(canonical)) continue;
    if (allowed && !allowed.has(canonical.toLowerCase())) continue;
    const matched = (units || []).some((u) => {
      const s = stripAdUnitSuffix(u).toLowerCase();
      return s === stripped || String(u).trim().toLowerCase() === raw;
    });
    if (matched) return canonical;
  }
  return '';
}

/** Unambiguous ad-unit → site host from GAM URL scan (SITE_NAME / URL_NAME). */
function buildAdUnitSiteMapFromUrlScan(rawUrlScan = [], adUnitByName = {}) {
  const candidates = new Map();
  const add = (adUnit, host) => {
    const h = normalizeHost(host) || String(host || '').toLowerCase().trim();
    if (!h || !adUnit || adUnit === '—') return;
    if (!adUnitAlignsWithSiteHost(adUnit, h)) return;
    [adUnit, stripAdUnitSuffix(adUnit)].forEach((key) => {
      const k = String(key || '').trim().toLowerCase();
      if (!k) return;
      if (!candidates.has(k)) candidates.set(k, new Set());
      candidates.get(k).add(h);
    });
  };
  rawUrlScan.forEach((r) => {
    const adUnit = cleanGamStr(r['Dimension.AD_UNIT_NAME']);
    const host = hostFromGamReportRow(r);
    if (adUnit && host) add(adUnit, host);
  });
  const map = new Map();
  candidates.forEach((hosts, adUnit) => {
    if (hosts.size === 1) map.set(adUnit, [...hosts][0]);
  });
  return map;
}

/** Filter-time ad-unit map: catalog + adUnitsByHost + URL scan, selected sites only. */
function buildFilterAdUnitHostMap({
  catalogRows = [],
  selectedSites = [],
  adUnitsByHost = {},
  urlScanMap = null,
} = {}) {
  const map = new Map();
  const add = (adUnit, host) => {
    const h = normalizeHost(host) || String(host || '').toLowerCase().trim();
    if (!h || !adUnit) return;
    if (!adUnitAlignsWithSiteHost(adUnit, h)) return;
    const selected = new Set(
      selectedSites.map((s) => (normalizeHost(s) || String(s).toLowerCase().trim())).filter(Boolean)
    );
    if (!selected.has(h)) return;
    [adUnit, stripAdUnitSuffix(adUnit)].forEach((key) => {
      const k = String(key || '').trim().toLowerCase();
      if (k && !map.has(k)) map.set(k, h);
    });
  };
  buildAssignedAdUnitHostMap(catalogRows, selectedSites).forEach((host, adUnit) => add(adUnit, host));
  buildAdUnitToSiteHostMap(adUnitsByHost, selectedSites).forEach((host, adUnit) => add(adUnit, host));
  const scan = urlScanMap instanceof Map
    ? urlScanMap
    : new Map(Object.entries(urlScanMap || {}));
  scan.forEach((host, adUnit) => add(adUnit, host));
  return map;
}

/** Ad unit → assigned site host (catalog rows + assigned list; allows multi-host fallback). */
function buildAssignedAdUnitHostMap(catalogRows = [], assignedSites = []) {
  const assigned = new Set(assignedSites.map((s) => String(s).toLowerCase().trim()).filter(Boolean));
  if (!assigned.size) return new Map();
  const candidates = new Map();
  const add = (adUnit, host) => {
    const h = normalizeHost(host) || String(host || '').toLowerCase().trim();
    if (!h || !adUnit || adUnit === '—') return;
    if (!adUnitAlignsWithSiteHost(adUnit, h)) return;
    let matched = assigned.has(h) ? h : '';
    if (!matched) return;
    [adUnit, stripAdUnitSuffix(adUnit)].forEach((key) => {
      const k = String(key || '').trim().toLowerCase();
      if (!k) return;
      if (!candidates.has(k)) candidates.set(k, new Set());
      candidates.get(k).add(matched);
    });
  };
  catalogRows.forEach((r) => {
    if (!r.site || r.site === '—') return;
    const host = pickSiteHost(
      r.siteUrl,
      r.gamSite,
      r.siteName,
      r.dimensions?.url_name,
      r.dimensions?.site_name
    );
    if (host) add(r.site, host);
  });
  const map = new Map();
  candidates.forEach((hosts, adUnit) => {
    const list = [...hosts];
    if (list.length === 1) map.set(adUnit, list[0]);
  });
  return map;
}

/** Infer siteUrl from ad-unit naming (gamebolte.com_game2_inter → game2.gamebolte.com) for assigned sites. */
function inferAssignedSiteHost(row = {}, assignedSites = [], adUnitToHost = new Map()) {
  const assigned = new Set(assignedSites.map((s) => String(s).toLowerCase().trim()).filter(Boolean));
  if (!assigned.size) return '';

  const existing = pickSiteHost(row.siteUrl, row.gamSite, row.siteName);
  if (existing && assigned.has(existing.toLowerCase()) && adUnitAlignsWithSiteHost(row.site, existing)) {
    return existing;
  }

  const fromCatalog = lookupSiteHostForAdUnit(row.site, adUnitToHost, {}, assignedSites);
  if (fromCatalog && assigned.has(fromCatalog.toLowerCase()) && adUnitAlignsWithSiteHost(row.site, fromCatalog)) {
    return fromCatalog;
  }

  const inferred = [
    subdomainFromAdUnit(row.site),
    subdomainFromSiteNameLabel(row.siteName),
  ]
    .map((h) => normalizeHost(h) || String(h || '').toLowerCase().trim())
    .filter(Boolean);
  const direct = inferred.find((h) => assigned.has(h));
  if (direct) return direct;
  for (const h of inferred) {
    if (!isSubdomainHost(h)) continue;
    for (const a of assigned) {
      if (a === h) return a;
    }
  }
  return '';
}

function fillAssignedSiteHostsForRows(rows = [], assignedSites = [], adUnitToHost = new Map()) {
  if (!assignedSites.length) return rows;
  return rows.map((row) => {
    const host = inferAssignedSiteHost(row, assignedSites, adUnitToHost);
    if (!host || !adUnitAlignsWithSiteHost(row.site, host)) return row;
    return enrichReportRow({ ...row, siteUrl: host, gamSite: host, siteName: host });
  });
}

/** Fix rows where site host root domain disagrees with ad-unit root (gamisco unit ↔ gamebolte site). */
function sanitizeRowSiteHost(row = {}) {
  const adUnit = row.site;
  const current = pickSiteHost(row.siteUrl, row.gamSite, row.siteName);
  if (!adUnit || adUnit === '—') return row;
  if (current && adUnitAlignsWithSiteHost(adUnit, current)) return row;
  const inferred = subdomainFromAdUnit(adUnit);
  const useInferred = inferred
    && isGamReportSiteHost(inferred)
    && !isAdUnitDerivedSiteHost(inferred)
    && adUnitAlignsWithSiteHost(adUnit, inferred);
  const fallbackHost = useInferred ? inferred : (domainFromAdUnit(adUnit) || '');
  if (!fallbackHost) {
    return enrichReportRow({ ...row, siteUrl: null, gamSite: null, siteName: '—' });
  }
  return enrichReportRow({ ...row, siteUrl: fallbackHost, gamSite: fallbackHost, siteName: fallbackHost });
}

function sanitizeRowsSiteHosts(rows = []) {
  return rows.map(sanitizeRowSiteHost);
}

/** Keep only hosts from filter-catalog siteHosts (Site dropdown parity). */
function alignToCatalogSiteHost(host, siteHosts = []) {
  const h = pickSiteHost(host);
  if (!h || isAdUnitDerivedSiteHost(h)) return '';
  if (!siteHosts.length) return '';
  const lower = h.toLowerCase();
  return siteHosts.find((s) => String(s).toLowerCase() === lower) || '';
}

/** Ad unit name → root domain from filter-catalog (Dashboard domain dropdown parity). */
function buildDomainByAdUnitMap(catalogRows = [], adUnitsByHost = {}, siteHosts = []) {
  const map = new Map();
  const add = (adUnit, domain) => {
    const root = normalizeHost(domain) || String(domain || '').trim().toLowerCase();
    if (!root || !adUnit || adUnit === '—') return;
    [adUnit, stripAdUnitSuffix(adUnit)].forEach((key) => {
      const k = String(key || '').trim().toLowerCase();
      if (k && !map.has(k)) map.set(k, root);
    });
  };
  catalogRows.forEach((r) => {
    const domain = readRootDomain(r);
    if (!domain || !r.site || r.site === '—') return;
    add(r.site, domain);
  });
  Object.entries(adUnitsByHost).forEach(([host, units]) => {
    const site = alignToCatalogSiteHost(host, siteHosts) || pickSiteHost(host);
    const domain = site ? rootDomainFromHost(site) : '';
    if (!domain) return;
    (units || []).forEach((au) => add(au, domain));
  });
  return map;
}

function lookupDomainForAdUnit(adUnit, domainByAdUnit = new Map()) {
  if (!adUnit || adUnit === '—') return '';
  const stripped = stripAdUnitSuffix(adUnit).toLowerCase();
  const raw = String(adUnit).trim().toLowerCase();
  return domainByAdUnit.get(raw) || domainByAdUnit.get(stripped) || '';
}

/** Site resolution context for Domain User — mirrors filter-catalog Site dropdown data. */
function buildDomainUserSiteContext(catalogPayload = {}) {
  const catalogRows = catalogPayload.rows || [];
  const filterOpts = buildCatalogFilterOptions(catalogRows, catalogPayload.rawHosts || {});
  const adUnitsByHost = catalogPayload.adUnitsByHost || {};
  const siteHosts = filterOpts.siteHosts || [];
  return {
    siteHosts,
    domainRoots: filterOpts.domainRoots || [],
    sitesByDomain: filterOpts.sitesByDomain || {},
    adUnitsByHost,
    adUnitToHost: buildAdUnitToSiteHostMap(adUnitsByHost, siteHosts),
    domainByAdUnit: buildDomainByAdUnitMap(catalogRows, adUnitsByHost, siteHosts),
  };
}

/** Ad unit → host only when catalog saw that ad unit with exactly one real site host. */
function buildUniqueSiteHostByAdUnit(rows = [], siteHosts = []) {
  const candidates = new Map();
  const add = (adUnit, host) => {
    const picked = pickSiteHost(host);
    if (!picked || !adUnit || adUnit === '—') return;
    if (!adUnitAlignsWithSiteHost(adUnit, picked)) return;
    const inCatalog = !siteHosts.length
      || siteHosts.some((s) => String(s).toLowerCase() === picked.toLowerCase());
    if (isAdUnitDerivedSiteHost(picked) && !inCatalog) return;
    const canonical = alignToCatalogSiteHost(picked, siteHosts) || picked;
    if (!isGamReportSiteHost(canonical) && !inCatalog) return;
    if (!candidates.has(adUnit)) candidates.set(adUnit, new Set());
    candidates.get(adUnit).add(canonical);
  };
  rows.forEach((r) => {
    const host = pickSiteHost(r.siteUrl, r.gamSite, r.siteName);
    if (!host || !r.site || r.site === '—') return;
    add(r.site, host);
    const stripped = stripAdUnitSuffix(r.site);
    if (stripped) add(stripped, host);
  });
  const map = {};
  candidates.forEach((hosts, adUnit) => {
    if (hosts.size === 1) map[adUnit] = [...hosts][0];
  });
  return map;
}

/**
 * Fill missing siteUrl only from unique GAM-observed ad-unit↔host pairs.
 * Does NOT use adUnitsByHost inheritance (that pulled sibling-site revenue into filters).
 */
function applyCatalogSiteHosts(rows = [], catalogRows = [], _adUnitsByHost = {}, siteHosts = []) {
  const siteByAdUnit = buildUniqueSiteHostByAdUnit(catalogRows, siteHosts);
  if (!Object.keys(siteByAdUnit).length) return rows;
  return rows.map((r) => {
    if (readSiteUrlFromFields(r, siteHosts)) return r;
    const stripped = stripAdUnitSuffix(r.site);
    const host = siteByAdUnit[r.site] || (stripped ? siteByAdUnit[stripped] : '');
    if (!host || !adUnitAlignsWithSiteHost(r.site, host)) return r;
    return enrichReportRow({ ...r, siteUrl: host, gamSite: host, siteName: host });
  });
}

function readSiteUrlFromFields(r, siteHosts = []) {
  const h = pickSiteHost(
    r.siteUrl,
    r.gamSite,
    r.siteName,
    r.dimensions?.url_name,
    r.dimensions?.site_name
  );
  if (!h) return '';
  const inCatalog = !siteHosts.length
    || siteHosts.some((s) => String(s).toLowerCase() === h.toLowerCase());
  // Drop invent-style hosts unless they are registered / catalogued SiteHosts.
  if (isAdUnitDerivedSiteHost(h) && !inCatalog) return '';
  // Prefer catalog spelling, but NEVER blank a real GAM host (catalog can lag today).
  return alignToCatalogSiteHost(h, siteHosts) || h;
}

/**
 * Do NOT inherit root-domain ad units onto every subdomain.
 * That made site filters include sibling/parent traffic and inflated revenue vs real GAM.
 */
function augmentAdUnitsByHost(adUnitsByHost = {}) {
  return adUnitsByHost;
}

/** Read adUnitsByHost from cached filter-catalog payload. */
function findCachedAdUnitsByHost(cache) {
  const catalog = cache.get(CATALOG_CACHE_KEY);
  return catalog?.adUnitsByHost || {};
}

/** Reverse map: site host → ad unit names (for subdomain → ad unit cascade). */
function buildAdUnitsByHost(rows = [], mergedSiteMap = {}) {
  const map = {};
  const add = (host, adUnit) => {
    if (!host || !adUnit || adUnit === '—') return;
    const h = normalizeHost(host) || String(host).toLowerCase().trim();
    if (!h) return;
    if (!map[h]) map[h] = new Set();
    map[h].add(adUnit);
  };
  rows.forEach((r) => {
    if (!r.site || r.site === '—') return;
    const host = pickSiteHost(r.siteUrl, r.gamSite, r.siteName);
    if (host) add(host, r.site);
    if (r.adUnitId && mergedSiteMap[r.adUnitId]) add(mergedSiteMap[r.adUnitId], r.site);
  });
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, Array.from(v).sort((a, b) => a.localeCompare(b))])
  );
}

/** Build adUnitId → host map from URL_NAME / SITE_NAME in the raw GAM catalog report. */
function buildReportSiteMap(raw = [], adUnitByName = {}) {
  const map = {};
  raw.forEach((r) => {
    let adUnitId = cleanGamStr(r['Dimension.AD_UNIT_ID']);
    const adUnit = cleanGamStr(r['Dimension.AD_UNIT_NAME']);
    if (!adUnitId && adUnit) {
      const stripped = adUnit.replace(/\s*\(\d+\)\s*$/, '').trim();
      adUnitId = adUnitByName[adUnit] || adUnitByName[stripped] || '';
    }
    const host = pickSiteHost(
      cleanGamStr(r['Dimension.URL_NAME']),
      cleanGamStr(r['Dimension.SITE_NAME'])
    );
    if (adUnitId && host) map[adUnitId] = host;
  });
  return map;
}

/** Resolve site URL from GAM Site column (SITE_NAME), then URL_NAME, then SITE_NAME + DOMAIN. */
function hostFromGamReportRow(r) {
  const siteDim = cleanGamStr(r['Dimension.SITE_NAME']);
  const siteFull = pickSiteHost(siteDim);
  if (siteFull && isGamReportSiteHost(siteFull)) return siteFull;

  const urlHost = pickSiteHost(cleanGamStr(r['Dimension.URL_NAME']));
  if (urlHost && isGamReportSiteHost(urlHost)) return urlHost;

  const domainRoot = pickSiteHost(cleanGamStr(r['Dimension.DOMAIN']))
    || domainFromAdUnit(cleanGamStr(r['Dimension.AD_UNIT_NAME']));
  if (domainRoot && siteDim) {
    const built = subdomainHostFromParts(domainRoot, siteDim);
    if (built && isGamReportSiteHost(built)) return built;
  }
  return '';
}

/** Extract GAM Site column values + per-domain map (matches GAM Site + Country report). */
function collectHostsFromRawReport(raw = []) {
  const domainRoots = new Set();
  const siteHosts = new Set();
  const sitesByDomain = {};
  const addHost = (host) => {
    if (!host || !isGamReportSiteHost(host)) return;
    const root = rootDomainFromHost(host);
    if (!root) return;
    domainRoots.add(root);
    siteHosts.add(host);
    if (!sitesByDomain[root]) sitesByDomain[root] = new Set();
    sitesByDomain[root].add(host);
  };
  raw.forEach((r) => addHost(hostFromGamReportRow(r)));
  return {
    domainRoots: Array.from(domainRoots).sort((a, b) => a.localeCompare(b)),
    siteHosts: Array.from(siteHosts).sort((a, b) => a.localeCompare(b)),
    sitesByDomain: Object.fromEntries(
      Object.entries(sitesByDomain).map(([k, v]) => [k, Array.from(v).sort((a, b) => a.localeCompare(b))])
    ),
  };
}

/** Add SiteService subdomain URLs missing from the report (roots stay in domain dropdown only). */
function supplementCatalogWithSites(rows = [], gamSites = []) {
  const seen = new Set();
  rows.forEach((r) => {
    const h = pickSiteHost(r.siteUrl, r.siteName, r.gamSite);
    if (h) seen.add(h);
  });
  const out = [...rows];
  gamSites.forEach((s) => {
    const host = normalizeHost(s.url);
    if (!host || seen.has(host) || !isSubdomainHost(host)) return;
    seen.add(host);
    out.push(enrichReportRow({
      date: '—',
      appId: '—',
      site: '—',
      gamDomain: '',
      gamSite: host,
      siteUrl: host,
    revenue: 0,
    impression: 0,
    }));
  });
  return out;
}

/** Domain roots from catalog rows; site URLs from GAM rawHosts (URL_NAME / SITE_NAME + DOMAIN). */
function buildCatalogFilterOptions(rows = [], extra = {}) {
  const domainRoots = new Set(extra.domainRoots || []);
  const siteHosts = new Set((extra.siteHosts || []).filter(isGamReportSiteHost));
  const sitesByDomain = { ...(extra.sitesByDomain || {}) };
  rows.forEach((r) => {
    const root = readRootDomain(r);
    if (root && root !== '—') domainRoots.add(root);
  });
  return {
    domainRoots: Array.from(domainRoots).sort((a, b) => a.localeCompare(b)),
    siteHosts: Array.from(siteHosts).sort((a, b) => a.localeCompare(b)),
    sitesByDomain,
  };
}

module.exports = {
  CATALOG_CACHE_KEY,
  findCachedInventoryRows,
  rowsToDomainOptions,
  readRootDomain,
  isLegacyAdUnitCatalog,
  dedupeCatalogRows,
  enrichCatalogRow,
  mapGamRowInventory,
  buildAdUnitNameToIdMap,
  buildReportSiteMap,
  mergeUrlScanIntoCatalog,
  buildAdUnitsByHost,
  augmentAdUnitsByHost,
  findCachedAdUnitsByHost,
  buildUniqueSiteHostByAdUnit,
  buildSiteHostByAdUnit: buildUniqueSiteHostByAdUnit,
  applyCatalogSiteHosts,
  applyHostToCatalogRow,
  supplementCatalogWithSites,
  buildCatalogFilterOptions,
  collectHostsFromRawReport,
  buildDomainUserSiteContext,
  buildAssignedAdUnitHostMap,
  buildAdUnitSiteMapFromUrlScan,
  buildFilterAdUnitHostMap,
  fillAssignedSiteHostsForRows,
  sanitizeRowSiteHost,
  sanitizeRowsSiteHosts,
  inferAssignedSiteHost,
  buildDomainByAdUnitMap,
  lookupDomainForAdUnit,
  stripAdUnitSuffix,
  buildAdUnitToSiteHostMap,
  lookupSiteHostForAdUnit,
  alignToCatalogSiteHost,
  hostFromGamReportRow,
  cleanGamStr,
  resolveAppFields,
  appPackageForPicker,
};
