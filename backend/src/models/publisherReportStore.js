/**
 * Daily report row upserts + overview aggregates for AdMob / AdSense.
 */
const { query } = require('../db');

async function upsertAdMobDailyRows(clientId, accountId, rows = []) {
  if (!rows.length) return 0;
  // Batch in chunks to cut round-trips
  const CHUNK = 50;
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((r, idx) => {
      const base = idx * 8;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3}::date,$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},now())`
      );
      params.push(
        clientId,
        accountId,
        r.reportDate,
        Number(r.earnings) || 0,
        Number(r.impressions) || 0,
        Number(r.clicks) || 0,
        Number(r.adRequests) || 0,
        Number(r.matchedRequests) || 0,
      );
    });
    await query(
      `INSERT INTO admob_report_daily (
         client_id, account_id, report_date,
         earnings, impressions, clicks, ad_requests, matched_requests, updated_at
       ) VALUES ${values.join(',')}
       ON CONFLICT (client_id, account_id, report_date) DO UPDATE SET
         earnings = EXCLUDED.earnings,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         ad_requests = EXCLUDED.ad_requests,
         matched_requests = EXCLUDED.matched_requests,
         updated_at = now()`,
      params
    );
    n += chunk.length;
  }
  return n;
}

async function upsertAdSenseDailyRows(clientId, accountId, rows = []) {
  if (!rows.length) return 0;
  const CHUNK = 50;
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((r, idx) => {
      const base = idx * 7;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3}::date,$${base + 4},$${base + 5},$${base + 6},$${base + 7},now())`
      );
      params.push(
        clientId,
        accountId,
        r.reportDate,
        Number(r.earnings) || 0,
        Number(r.pageViews) || 0,
        Number(r.impressions) || 0,
        Number(r.clicks) || 0,
      );
    });
    await query(
      `INSERT INTO adsense_report_daily (
         client_id, account_id, report_date,
         earnings, page_views, impressions, clicks, updated_at
       ) VALUES ${values.join(',')}
       ON CONFLICT (client_id, account_id, report_date) DO UPDATE SET
         earnings = EXCLUDED.earnings,
         page_views = EXCLUDED.page_views,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         updated_at = now()`,
      params
    );
    n += chunk.length;
  }
  return n;
}

async function sumAdMobRange(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(earnings), 0)::float AS earnings,
       COALESCE(SUM(impressions), 0)::bigint AS impressions,
       COALESCE(SUM(clicks), 0)::bigint AS clicks,
       COALESCE(SUM(ad_requests), 0)::bigint AS ad_requests,
       COALESCE(SUM(matched_requests), 0)::bigint AS matched_requests
     FROM admob_report_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}`,
    params
  );
  return rows[0] || {
    earnings: 0, impressions: 0, clicks: 0, ad_requests: 0, matched_requests: 0,
  };
}

async function trendAdMob(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT report_date::text AS date,
            SUM(earnings)::float AS earnings,
            SUM(impressions)::bigint AS impressions
     FROM admob_report_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}
     GROUP BY report_date
     ORDER BY report_date ASC`,
    params
  );
  return rows;
}

async function sumAdSenseRange(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(earnings), 0)::float AS earnings,
       COALESCE(SUM(page_views), 0)::bigint AS page_views,
       COALESCE(SUM(impressions), 0)::bigint AS impressions,
       COALESCE(SUM(clicks), 0)::bigint AS clicks
     FROM adsense_report_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}`,
    params
  );
  return rows[0] || { earnings: 0, page_views: 0, impressions: 0, clicks: 0 };
}

async function trendAdSense(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT report_date::text AS date,
            SUM(earnings)::float AS earnings,
            SUM(page_views)::bigint AS page_views
     FROM adsense_report_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}
     GROUP BY report_date
     ORDER BY report_date ASC`,
    params
  );
  return rows;
}

module.exports = {
  upsertAdMobDailyRows,
  upsertAdSenseDailyRows,
  sumAdMobRange,
  trendAdMob,
  sumAdSenseRange,
  trendAdSense,
};
