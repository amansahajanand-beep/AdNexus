/**
 * GAM v202602 inventory data fetchers.
 *
 * Services probed:
 *   SiteService              — registered site URLs (MCM / publisher)
 *   InventoryService         — ad unit hierarchy (always available)
 *   MobileApplicationService — mobile app bundle IDs
 *
 * Call order for Site data:
 *   1. SiteService.getSitesByStatement  → authoritative if available
 *   2. InventoryService level-2 units   → fallback (direct children of root)
 */

const axios = require('axios');
const { GAM_API_VERSION } = require('./gamVersion');
const { cache } = require('../gam/client');
const logger = require('./logger');
const { isLikelyWebDomain, isLikelyAdUnitName } = require('./adUnit');

const { getClient } = require('./clientContext');
const NETWORK_CODE = () => getClient()?.networkCode || process.env.GAM_NETWORK_CODE;
const BASE = `https://ads.google.com/apis/ads/publisher/${GAM_API_VERSION}`;

// ─── Shared SOAP helper ───────────────────────────────────────────────────────

function soapEnvelope(service, method, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${GAM_API_VERSION}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${NETWORK_CODE()}</dfp:networkCode>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <${method} xmlns="https://www.google.com/apis/ads/publisher/${GAM_API_VERSION}">${body}</${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function soapCall(service, method, body, token) {
  const res = await axios.post(
    `${BASE}/${service}`,
    soapEnvelope(service, method, body),
    {
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPAction': '',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 300000, // 5 min
    }
  );
  return res.data;
}

/** Extract all <results> blocks from a SOAP response. */
function parseResults(xml) {
  const results = [];
  const re = /<results[^>]*>([\s\S]*?)<\/results>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]);
  }
  return results;
}

/** Extract first text value of a tag from a block (supports xsi attributes and namespaces). */
function extractTag(block, tag) {
  const patterns = [
    new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([^<]*)<\\/(?:[^:>]+:)?${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'),
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return '';
}

function extractMobileAppPackage(block) {
  const candidates = [
    'applicationId',
    'platformApplicationId',
    'bundleId',
    'packageName',
    'storeId',
  ];
  for (const tag of candidates) {
    const val = extractTag(block, tag);
    if (val && !/^\d+$/.test(val) && !/\s/.test(val)) return val;
  }
  const storeUrl = extractTag(block, 'mobileStoreUrl') || extractTag(block, 'storeUrl');
  if (storeUrl) {
    const idMatch = storeUrl.match(/[?&]id=([a-zA-Z0-9._]+)/);
    if (idMatch?.[1] && idMatch[1].includes('.')) return idMatch[1];
  }
  return '';
}

// ─── SiteService ─────────────────────────────────────────────────────────────

/**
 * Try SiteService.getSitesByStatement.
 * Returns array of {id, url} or null if service is unavailable for this network.
 */
async function fetchSitesBySiteService(token) {
  const cacheKey = 'gam_sites_v3';
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const xml = await soapCall(
      'SiteService',
      'getSitesByStatement',
      `<filterStatement><query>LIMIT 500</query></filterStatement>`,
      token
    );

    // Check for SOAP fault — SiteService not enabled for this network
    if (xml.includes('<faultstring>') || xml.includes('ServiceNotEnabled') || xml.includes('PERMISSION_DENIED')) {
      logger.info('[SiteService] Not available for this network — will use InventoryService fallback');
      cache.set(cacheKey, null, 3600);
      return null;
    }

    const blocks = parseResults(xml);
    const sites = blocks.map(b => ({
      id: extractTag(b, 'id'),
      url: extractTag(b, 'url'),
      approvalStatus: extractTag(b, 'approvalStatus'),
    })).filter((s) => {
      if (!s.url) return false;
      const status = String(s.approvalStatus || '').toUpperCase();
      // Keep sites that can serve (exclude only clearly rejected).
      if (!status) return true;
      return status !== 'DISAPPROVED' && status !== 'FAILED';
    });

    logger.info(`[SiteService] Found ${sites.length} sites:`, sites.slice(0, 5).map(s => s.url).join(' | '));
    cache.set(cacheKey, sites, 600);
    return sites;
  } catch (err) {
    // 403 / SOAP fault / unknown service — not available
    const msg = err.response?.data || err.message || '';
    if (err.response?.status === 403 || String(msg).includes('fault') || String(msg).includes('not')) {
      logger.info('[SiteService] Unavailable:', err.response?.status || err.message);
    } else {
      logger.warn('[SiteService] Unexpected error:', err.message);
    }
    cache.set(cacheKey, null, 3600);
    return null;
  }
}

// ─── InventoryService ─────────────────────────────────────────────────────────

/**
 * Fetch all active ad units with their id, parentId, name, adUnitCode.
 * Returns {units, rootId, level2} where level2 = direct children of root.
 */
async function fetchAdUnitHierarchy(token) {
  const cacheKey = 'gam_ad_unit_hierarchy_v1';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const xml = await soapCall(
    'InventoryService',
    'getAdUnitsByStatement',
    `<filterStatement><query>WHERE status = 'ACTIVE' LIMIT 500</query></filterStatement>`,
    token
  );

  const blocks = parseResults(xml);
  const units = blocks.map(b => ({
    id: extractTag(b, 'id'),
    parentId: extractTag(b, 'parentId'),
    name: extractTag(b, 'name'),
    code: extractTag(b, 'adUnitCode'),
  })).filter(u => u.id);

  // Root = unit whose parentId does not exist in the set (or has no parentId)
  const allIds = new Set(units.map(u => u.id));
  const root = units.find(u => !u.parentId || !allIds.has(u.parentId));
  const rootId = root?.id || '';

  // Level-2 = direct children of root — these map to actual sites/subdomains
  const level2 = rootId ? units.filter(u => u.parentId === rootId) : [];

  logger.info(`[InventoryService] ${units.length} units | root: ${root?.name}(${rootId}) | level-2 sites: ${level2.map(u => u.name).join(' | ')}`);

  const result = { units, rootId, level2 };
  cache.set(cacheKey, result, 600);
  return result;
}

/**
 * Build map: adUnitId → site URL/host (subdomain).
 * Prefers SiteService URLs for level-2 inventory units; falls back to unit name when it looks like a host.
 */
function buildSiteMapFromHierarchy({ units, rootId, level2 }, gamSites = null) {
  const idToUnit = Object.fromEntries(units.map(u => [u.id, u]));
  const level2Ids = new Set(level2.map(u => u.id));
  const siteUrlByLevel2Id = {};
  const siteById = gamSites?.length
    ? Object.fromEntries(gamSites.map((s) => [s.id, s.url]))
    : {};

  level2.forEach((u) => {
    const fromService = siteById[u.id];
    const fromName = u.name;
    const host = fromService
      ? fromService.replace(/^https?:\/\//, '').split('/')[0]
      : (!isLikelyAdUnitName(fromName) && isLikelyWebDomain(fromName) ? fromName : '');
    siteUrlByLevel2Id[u.id] = host && !isLikelyAdUnitName(host) ? host : '';
  });

  const siteMap = {};
  for (const u of units) {
    if (u.id === rootId) continue;
    let cur = u;
    let depth = 0;
    while (cur && cur.parentId && !level2Ids.has(cur.id) && depth < 10) {
      cur = idToUnit[cur.parentId];
      depth++;
    }
    if (cur && level2Ids.has(cur.id)) {
      const host = siteUrlByLevel2Id[cur.id];
      if (host) siteMap[u.id] = host;
    }
  }
  return siteMap;
}

// ─── MobileApplicationService ─────────────────────────────────────────────────

/**
 * Fetch mobile applications.
 * Returns [{id, displayName, appStore, applicationId}] or null if unavailable.
 */
async function fetchMobileApps(token) {
  const cacheKey = 'gam_mobile_apps_v4';
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const all = [];
    const pageSize = 500;
    let offset = 0;

    while (offset <= 20000) {
      const xml = await soapCall(
        'MobileApplicationService',
        'getMobileApplicationsByStatement',
        `<filterStatement><query>WHERE isArchived = false LIMIT ${pageSize} OFFSET ${offset}</query></filterStatement>`,
        token
      );

      if (xml.includes('<faultstring>') || xml.includes('ServiceNotEnabled')) {
        logger.info('[MobileApplicationService] Not available for this network');
        cache.set(cacheKey, null, 3600);
        return null;
      }

      const blocks = parseResults(xml);
      const apps = blocks.map((b) => ({
        id: extractTag(b, 'id'),
        displayName: extractTag(b, 'displayName'),
        appStore: extractTag(b, 'appStore'),
        applicationId: extractMobileAppPackage(b) || extractTag(b, 'applicationId'),
      })).filter((a) => a.id);

      all.push(...apps);
      if (apps.length < pageSize) break;
      offset += pageSize;
    }

    logger.info(`[MobileApplicationService] Found ${all.length} apps`);
    cache.set(cacheKey, all, 3600);
    return all;
  } catch (err) {
    logger.info('[MobileApplicationService] Unavailable:', err.message);
    cache.set(cacheKey, null, 3600);
    return null;
  }
}

// ─── Main export: site map for catalog enrichment ────────────────────────────

/**
 * Returns {siteMap, sites, mobileApps} for catalog enrichment.
 *
 * siteMap: { adUnitId → siteUrl }  — used in enrichCatalogRow
 * sites:   [{id, url}]             — from SiteService or InventoryService level-2
 * mobileApps: [{id, applicationId, displayName}] or null
 *
 * Strategy:
 *   1. Try SiteService for authoritative site URLs.
 *   2. If SiteService unavailable/empty → use InventoryService level-2 unit names as site URLs.
 *   3. adUnitId→siteUrl map always comes from InventoryService hierarchy.
 */
async function fetchGAMInventoryData(token) {
  const cacheKey = 'gam_inventory_data_v5';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const [gamSites, hierarchy, mobileApps] = await Promise.all([
    fetchSitesBySiteService(token),
    fetchAdUnitHierarchy(token),
    fetchMobileApps(token),
  ]);

  // Build adUnitId → site host from InventoryService hierarchy (+ SiteService URLs when available)
  const siteMap = buildSiteMapFromHierarchy(hierarchy, gamSites);

  // Prefer SiteService sites; fall back to level-2 unit names
  let sites;
  if (gamSites && gamSites.length > 0) {
    sites = gamSites; // [{id, url, approvalStatus}]
    logger.info('[inventory] Using SiteService data for sites');
  } else {
    sites = hierarchy.level2.map(u => ({ id: u.id, url: u.name }));
    logger.info('[inventory] Using InventoryService level-2 as sites:', sites.map(s => s.url).join(' | '));
  }

  const result = { siteMap, sites, adUnits: hierarchy.units, mobileApps };
  cache.set(cacheKey, result, 600);
  return result;
}

module.exports = {
  fetchGAMInventoryData,
  fetchSitesBySiteService,
  fetchAdUnitHierarchy,
  fetchMobileApps,
};
