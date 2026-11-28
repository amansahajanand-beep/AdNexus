/**
 * Ad Insights — read-only Google Ads queries for an account's apps, creative assets and keywords.
 * Uses the same OAuth / MCC plumbing as the spend sync (see ./client.js).
 */
const { enums, fromMicros } = require('google-ads-api');
const { createAdsApi, customerClient, gaqlQuery } = require('./client');

const MAX_DAYS = 365;

function enumName(group, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return enums[group]?.[value] || String(value);
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function dateRange(days) {
  const n = Math.min(MAX_DAYS, Math.max(1, parseInt(days, 10) || 30));
  const end = new Date();
  const start = new Date(end.getTime() - (n - 1) * 86400000);
  return { start: ymd(start), end: ymd(end), days: n };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function metricsOf(m = {}) {
  const impressions = num(m.impressions);
  const clicks = num(m.clicks);
  const cost = fromMicros(num(m.cost_micros ?? m.costMicros));
  const conversions = num(m.conversions);
  return {
    impressions,
    clicks,
    cost,
    conversions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    cpc: clicks > 0 ? cost / clicks : 0,
    cpa: conversions > 0 ? cost / conversions : 0,
  };
}

function addInto(acc, m) {
  acc.impressions += m.impressions;
  acc.clicks += m.clicks;
  acc.cost += m.cost;
  acc.conversions += m.conversions;
}

function finalize(acc) {
  return {
    ...acc,
    ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : 0,
    cpc: acc.clicks > 0 ? acc.cost / acc.clicks : 0,
    cpa: acc.conversions > 0 ? acc.cost / acc.conversions : 0,
  };
}

function emptyTotals() {
  return { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
}

function cidFilter(campaignId) {
  const id = String(campaignId || '').replace(/\D/g, '');
  return id ? ` AND campaign.id = ${id}` : '';
}

function open(gamClient, account, refreshToken) {
  const api = createAdsApi(gamClient);
  return customerClient(api, {
    customerId: account.customerId,
    refreshToken,
    loginCustomerId: account.loginCustomerId,
  });
}

/** Campaigns (with app id / store when it is an app campaign) and their spend in the window. */
async function fetchApps(gamClient, account, refreshToken, { days } = {}) {
  const customer = open(gamClient, account, refreshToken);
  const { start, end } = dateRange(days);
  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
      campaign.app_campaign_setting.app_id, campaign.app_campaign_setting.app_store,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND campaign.status != 'REMOVED'
  `);
  const byApp = new Map();
  for (const r of rows || []) {
    const c = r.campaign || {};
    const setting = c.app_campaign_setting || {};
    const appId = String(setting.app_id || '').trim();
    const key = appId || `campaign:${c.id}`;
    let app = byApp.get(key);
    if (!app) {
      app = {
        key,
        appId: appId || null,
        store: appId ? enumName('AppCampaignAppStore', setting.app_store) : null,
        name: appId || c.name || '',
        isApp: Boolean(appId),
        campaigns: [],
        totals: emptyTotals(),
      };
      byApp.set(key, app);
    }
    const m = metricsOf(r.metrics);
    app.campaigns.push({
      campaignId: String(c.id),
      campaignName: c.name || '',
      status: enumName('CampaignStatus', c.status),
      channel: enumName('AdvertisingChannelType', c.advertising_channel_type),
      ...m,
    });
    addInto(app.totals, m);
  }
  const apps = [...byApp.values()].map((a) => ({ ...a, totals: finalize(a.totals) }));
  apps.sort((a, b) => b.totals.cost - a.totals.cost);
  return apps;
}

/** Creative assets (headlines, descriptions, images, videos) with Google's performance label. */
async function fetchAssets(gamClient, account, refreshToken, { days, campaignId } = {}) {
  const customer = open(gamClient, account, refreshToken);
  const { start, end } = dateRange(days);
  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id, campaign.name, ad_group.name,
      asset.id, asset.type, asset.name,
      asset.text_asset.text,
      asset.image_asset.full_size.url,
      asset.image_asset.full_size.width_pixels,
      asset.image_asset.full_size.height_pixels,
      asset.youtube_video_asset.youtube_video_id,
      asset.youtube_video_asset.youtube_video_title,
      ad_group_ad_asset_view.field_type,
      ad_group_ad_asset_view.performance_label,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM ad_group_ad_asset_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND ad_group_ad_asset_view.enabled = TRUE
      AND campaign.status != 'REMOVED'${cidFilter(campaignId)}
  `);

  const byAsset = new Map();
  for (const r of rows || []) {
    const a = r.asset || {};
    const view = r.ad_group_ad_asset_view || {};
    const fieldType = enumName('AssetFieldType', view.field_type);
    const key = `${a.id}:${fieldType}`;
    let item = byAsset.get(key);
    if (!item) {
      const type = enumName('AssetType', a.type);
      const ytId = a.youtube_video_asset?.youtube_video_id || null;
      item = {
        id: String(a.id),
        type,
        fieldType,
        name: a.name || '',
        text: a.text_asset?.text || null,
        imageUrl: a.image_asset?.full_size?.url || null,
        width: num(a.image_asset?.full_size?.width_pixels) || null,
        height: num(a.image_asset?.full_size?.height_pixels) || null,
        youtubeId: ytId,
        videoTitle: a.youtube_video_asset?.youtube_video_title || null,
        thumbnail: ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : null,
        performanceLabel: enumName('AssetPerformanceLabel', view.performance_label),
        campaigns: new Set(),
        totals: emptyTotals(),
      };
      byAsset.set(key, item);
    }
    // Keep the best-known label if the same asset appears in several ad groups.
    const label = enumName('AssetPerformanceLabel', view.performance_label);
    const rank = { BEST: 5, GOOD: 4, LEARNING: 3, LOW: 2, PENDING: 1, UNSPECIFIED: 0, UNKNOWN: 0 };
    if ((rank[label] || 0) > (rank[item.performanceLabel] || 0)) item.performanceLabel = label;
    if (r.campaign?.name) item.campaigns.add(r.campaign.name);
    addInto(item.totals, metricsOf(r.metrics));
  }

  const assets = [...byAsset.values()].map((i) => ({
    ...i,
    campaigns: [...i.campaigns],
    totals: finalize(i.totals),
  }));
  assets.sort((a, b) => b.totals.impressions - a.totals.impressions || b.totals.cost - a.totals.cost);
  return assets;
}

/** Search-campaign keywords. App campaigns have none; the UI says so and falls back to search terms. */
async function fetchKeywords(gamClient, account, refreshToken, { days, campaignId } = {}) {
  const customer = open(gamClient, account, refreshToken);
  const { start, end } = dateRange(days);
  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id, campaign.name, ad_group.name,
      ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.status,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM keyword_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND ad_group_criterion.status != 'REMOVED'
      AND ad_group_criterion.negative = FALSE
      AND campaign.status != 'REMOVED'${cidFilter(campaignId)}
  `);
  const byKw = new Map();
  for (const r of rows || []) {
    const crit = r.ad_group_criterion || {};
    const text = crit.keyword?.text || '';
    if (!text) continue;
    const match = enumName('KeywordMatchType', crit.keyword?.match_type);
    const key = `${text.toLowerCase()}|${match}|${r.campaign?.id}`;
    let k = byKw.get(key);
    if (!k) {
      k = {
        keyword: text,
        matchType: match,
        campaign: r.campaign?.name || '',
        adGroup: r.ad_group?.name || '',
        qualityScore: num(crit.quality_info?.quality_score) || null,
        totals: emptyTotals(),
      };
      byKw.set(key, k);
    }
    addInto(k.totals, metricsOf(r.metrics));
  }
  const keywords = [...byKw.values()].map((k) => ({ ...k, totals: finalize(k.totals) }));
  keywords.sort((a, b) => b.totals.clicks - a.totals.clicks || b.totals.impressions - a.totals.impressions);
  return keywords;
}

/** Queries people actually typed before seeing the ad (search + app campaigns that expose it). */
async function fetchSearchTerms(gamClient, account, refreshToken, { days, campaignId } = {}) {
  const customer = open(gamClient, account, refreshToken);
  const { start, end } = dateRange(days);
  const rows = await gaqlQuery(customer, `
    SELECT
      campaign.id, campaign.name,
      search_term_view.search_term, search_term_view.status,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM search_term_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'${cidFilter(campaignId)}
  `);
  const byTerm = new Map();
  for (const r of rows || []) {
    const term = r.search_term_view?.search_term || '';
    if (!term) continue;
    const key = `${term.toLowerCase()}|${r.campaign?.id}`;
    let t = byTerm.get(key);
    if (!t) {
      t = { term, campaign: r.campaign?.name || '', totals: emptyTotals() };
      byTerm.set(key, t);
    }
    addInto(t.totals, metricsOf(r.metrics));
  }
  const terms = [...byTerm.values()].map((t) => ({ ...t, totals: finalize(t.totals) }));
  terms.sort((a, b) => b.totals.clicks - a.totals.clicks || b.totals.impressions - a.totals.impressions);
  return terms;
}

async function fetchCurrency(gamClient, account, refreshToken) {
  try {
    const customer = open(gamClient, account, refreshToken);
    const rows = await gaqlQuery(customer, 'SELECT customer.currency_code FROM customer LIMIT 1');
    return rows?.[0]?.customer?.currency_code || account.currencyCode || 'USD';
  } catch {
    return account.currencyCode || 'USD';
  }
}

module.exports = {
  dateRange,
  fetchApps,
  fetchAssets,
  fetchKeywords,
  fetchSearchTerms,
  fetchCurrency,
};
