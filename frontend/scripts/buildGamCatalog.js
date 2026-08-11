/**
 * Build gamReportCatalogData.js from GAM API v202505 Dimension/Column docs.
 * Run: node scripts/buildGamCatalog.js
 */
const fs = require('fs');
const path = require('path');

const dimPath = path.join(__dirname, '../../../.cursor/projects/c-Users-romik-Downloads-gam-dashboard-v3-mockfix-gam-dashboard-realtime-data/agent-tools/83c2e5a8-e684-4907-9461-d93c25128b6d.txt');
const colPath = path.join(__dirname, '../../../.cursor/projects/c-Users-romik-Downloads-gam-dashboard-v3-mockfix-gam-dashboard-realtime-data/agent-tools/edd370eb-f301-4da1-95fe-af85a728cd1e.txt');

// Fallback paths when run from workspace
const dimAlt = 'C:/Users/romik/.cursor/projects/c-Users-romik-Downloads-gam-dashboard-v3-mockfix-gam-dashboard-realtime-data/agent-tools/83c2e5a8-e684-4907-9461-d93c25128b6d.txt';
const colAlt = 'C:/Users/romik/.cursor/projects/c-Users-romik-Downloads-gam-dashboard-v3-mockfix-gam-dashboard-realtime-data/agent-tools/edd370eb-f301-4da1-95fe-af85a728cd1e.txt';

function readFirst(...paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('GAM doc files not found');
}

function slug(api) {
  return api.toLowerCase();
}

function parseRows(text, kind) {
  const rows = [];
  const re = /\| `([A-Z0-9_]+)` \| ([^|]+) \|/g;
  let m;
  while ((m = re.exec(text))) {
    const api = m[1];
    const desc = m[2].trim();
    if (kind === 'dim' && api.startsWith('DP_')) continue;

    let label = null;
    const ui = desc.match(/Corresponds to "([^"]+)" in the Ad Manager UI/);
    if (ui) label = ui[1];
    else {
      const can = desc.match(/Can correspond to any of the following in the Ad Manager UI: ([^.]+)/);
      if (can) label = can[1].split(',')[0].trim();
    }
    if (!label) {
      const also = desc.match(/also known as "([^"]+)"/i);
      if (also) label = also[1];
    }
    if (!label) {
      label = api.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
    }

    rows.push({ id: slug(api), label, api });
  }
  return rows;
}

function categorizeDimension(item) {
  const a = item.api;
  if (/^(DATE|MONTH|WEEK|DAY|HOUR)/.test(a) || a.includes('_PT')) return 'time';
  if (/COUNTRY|REGION|CITY|METRO|POSTAL/.test(a)) return 'userGeography';
  if (/AD_UNIT|PLACEMENT|DOMAIN|SITE_|URL_|MOBILE_APP|MOBILE_DEVICE|MOBILE_INVENTORY|REQUEST_TYPE|INVENTORY_FORMAT|WEB_PROPERTY|CHANNEL_NAME/.test(a)) return 'inventory';
  if (/VIDEO_|POSITION_|VAST|FALLBACK|PLCMT/.test(a)) return 'video';
  if (/ORDER|LINE_ITEM|CREATIVE|ADVERTISER|SALESPERSON|BUYING_AGENCY|CLASSIFIED_ADVERTISER|CLASSIFIED_BRAND/.test(a)) return 'delivery';
  if (/PROGRAMMATIC|DEMAND_CHANNEL|BUYER_|BIDDER|DEAL|YIELD_|EXCHANGE_BIDDING|IS_FIRST_LOOK|IS_ADX/.test(a)) return 'programmatic';
  if (/DEVICE|BROWSER|OPERATING_SYSTEM|TARGETING|BANDWIDTH|CARRIER|AD_TYPE|AD_LOCATION|BRANDING/.test(a)) return 'adTechnology';
  if (/AUDIENCE|GRP_DEMOGRAPHICS|NIELSEN/.test(a)) return 'audience';
  if (/CONTENT|CMS_METADATA|CUSTOM_SPOT/.test(a)) return 'content';
  if (/PARTNER_|INVENTORY_SHARE/.test(a)) return 'partners';
  if (/CUSTOM_|KEY.?VALUE|CRITERIA/.test(a)) return 'customTargeting';
  if (/NATIVE_|MEDIATION_|AD_NETWORK|SDK/.test(a)) return 'mediation';
  if (/PRICING|SERVING_RESTRICTION|BID_|AD_TECHNOLOGY_PROVIDER|TCF_/.test(a)) return 'pricingBidding';
  return 'other';
}

function categorizeMetric(item) {
  const a = item.api;
  if (/ACTIVE_VIEW/.test(a)) return 'activeView';
  if (/^TOTAL_LINE_ITEM|^TOTAL_CODE|^TOTAL_AD|^TOTAL_RESPONSE|^TOTAL_UNMATCH|^TOTAL_FILL|^TOTAL_INVENTORY|^TOTAL_PROGRAMMATIC|^TOTAL_VIDEO/.test(a)) return 'total';
  if (/^AD_SERVER/.test(a)) return 'adServer';
  if (/^ADSENSE/.test(a)) return 'adsense';
  if (/^AD_EXCHANGE/.test(a)) return 'adExchange';
  if (/^PROGRAMMATIC|^DEALS_|^YIELD_GROUP|^MEDIATION_|^BID_/.test(a)) return 'programmatic';
  if (/^VIDEO_|^RICH_MEDIA|^DROPOFF|^TRUEVIEW/.test(a)) return 'video';
  if (/^UNIQUE_REACH|^SELL_THROUGH|^PARTNER_SALES/.test(a)) return 'reachForecast';
  if (/^SDK_/.test(a)) return 'sdkMediation';
  return 'other';
}

const CAT_LABELS = {
  time: 'Time',
  userGeography: 'User geography',
  inventory: 'Inventory',
  video: 'Video',
  delivery: 'Delivery',
  programmatic: 'Programmatic',
  adTechnology: 'Ad technology',
  audience: 'Audience',
  content: 'Content',
  partners: 'Partners',
  customTargeting: 'Custom targeting',
  mediation: 'Mediation & SDK',
  pricingBidding: 'Pricing & bidding',
  other: 'Other',
  total: 'Total',
  adServer: 'Ad server',
  adsense: 'AdSense',
  adExchange: 'Ad Exchange',
  activeView: 'Active View',
  reachForecast: 'Reach & forecast',
  sdkMediation: 'SDK mediation',
};

function groupItems(items, categorizeFn) {
  const map = {};
  items.forEach(item => {
    const cat = categorizeFn(item);
    if (!map[cat]) map[cat] = [];
    map[cat].push({ id: item.id, label: item.label, api: item.api });
  });
  const order = Object.keys(CAT_LABELS);
  return order
    .filter(id => map[id]?.length)
    .map(id => ({ id, label: CAT_LABELS[id], items: map[id] }));
}

const dimText = readFirst(dimPath, dimAlt);
const colText = readFirst(colPath, colAlt);
const dims = parseRows(dimText, 'dim');
const cols = parseRows(colText, 'col');

const GAM_DIMENSION_CATEGORIES = groupItems(dims, categorizeDimension);
const GAM_METRIC_CATEGORIES = groupItems(cols, categorizeMetric);

const out = `/**
 * AUTO-GENERATED from GAM API v202505 Dimension + Column enums.
 * ${dims.length} dimensions · ${cols.length} metrics — matches real Ad Manager report builder.
 * Regenerate: node scripts/buildGamCatalog.js
 */

export const GAM_DIMENSION_CATEGORIES = ${JSON.stringify(GAM_DIMENSION_CATEGORIES, null, 2)};

export const GAM_METRIC_CATEGORIES = ${JSON.stringify(GAM_METRIC_CATEGORIES, null, 2)};

export const GAM_CATALOG_STATS = { dimensions: ${dims.length}, metrics: ${cols.length} };
`;

const outPath = path.join(__dirname, '../src/utils/gamReportCatalogData.js');
fs.writeFileSync(outPath, out);
console.log('Wrote', outPath, `(${dims.length} dims, ${cols.length} metrics)`);
