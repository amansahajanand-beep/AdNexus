/**
 * AdMob / AdSense daily rollups — precomputed KPIs for fast dashboard reads.
 * Rebuilt from *_report_daily fact tables after each sync.
 */
const { query } = require('../db');
const logger = require('../utils/logger');

async function rebuildAdMobRollups(clientId, { accountId = null, startDate, endDate } = {}) {
  if (!clientId || !startDate || !endDate) return 0;
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND f.account_id = $${params.length}`;
  }

  const res = await query(
    `INSERT INTO admob_rollup_daily (
       client_id, account_id, report_date,
       earnings, impressions, clicks, ad_requests, matched_requests,
       ctr, ecpm, match_rate, currency, synced_at
     )
     SELECT
       f.client_id,
       f.account_id,
       f.report_date,
       COALESCE(SUM(f.earnings), 0)::float8,
       COALESCE(SUM(f.impressions), 0)::bigint,
       COALESCE(SUM(f.clicks), 0)::bigint,
       COALESCE(SUM(f.ad_requests), 0)::bigint,
       COALESCE(SUM(f.matched_requests), 0)::bigint,
       CASE WHEN COALESCE(SUM(f.impressions), 0) > 0
         THEN (COALESCE(SUM(f.clicks), 0)::float8 / SUM(f.impressions) * 100)::real
         ELSE 0 END,
       CASE WHEN COALESCE(SUM(f.impressions), 0) > 0
         THEN (COALESCE(SUM(f.earnings), 0) / SUM(f.impressions) * 1000)::real
         ELSE 0 END,
       CASE WHEN COALESCE(SUM(f.ad_requests), 0) > 0
         THEN (COALESCE(SUM(f.matched_requests), 0)::float8 / SUM(f.ad_requests) * 100)::real
         ELSE 0 END,
       COALESCE(MAX(a.currency_code), 'USD'),
       NOW()
     FROM admob_report_daily f
     LEFT JOIN admob_accounts a ON a.id = f.account_id
     WHERE f.client_id = $1::uuid
       AND f.report_date >= $2::date AND f.report_date <= $3::date
       ${accountClause}
     GROUP BY f.client_id, f.account_id, f.report_date
     ON CONFLICT (client_id, account_id, report_date) DO UPDATE SET
       earnings = EXCLUDED.earnings,
       impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks,
       ad_requests = EXCLUDED.ad_requests,
       matched_requests = EXCLUDED.matched_requests,
       ctr = EXCLUDED.ctr,
       ecpm = EXCLUDED.ecpm,
       match_rate = EXCLUDED.match_rate,
       currency = EXCLUDED.currency,
       synced_at = EXCLUDED.synced_at`,
    params
  );
  const n = res.rowCount || 0;
  if (n) logger.info(`[admob-rollup] rebuilt ${n} day(s) client=${String(clientId).slice(0, 8)}`);
  return n;
}

async function rebuildAdSenseRollups(clientId, { accountId = null, startDate, endDate } = {}) {
  if (!clientId || !startDate || !endDate) return 0;
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND f.account_id = $${params.length}`;
  }

  const res = await query(
    `INSERT INTO adsense_rollup_daily (
       client_id, account_id, report_date,
       earnings, page_views, impressions, clicks,
       ctr, rpm, ecpm, currency, synced_at
     )
     SELECT
       f.client_id,
       f.account_id,
       f.report_date,
       COALESCE(SUM(f.earnings), 0)::float8,
       COALESCE(SUM(f.page_views), 0)::bigint,
       COALESCE(SUM(f.impressions), 0)::bigint,
       COALESCE(SUM(f.clicks), 0)::bigint,
       CASE WHEN COALESCE(SUM(f.impressions), 0) > 0
         THEN (COALESCE(SUM(f.clicks), 0)::float8 / SUM(f.impressions) * 100)::real
         ELSE 0 END,
       CASE WHEN COALESCE(SUM(f.page_views), 0) > 0
         THEN (COALESCE(SUM(f.earnings), 0) / SUM(f.page_views) * 1000)::real
         ELSE 0 END,
       CASE WHEN COALESCE(SUM(f.impressions), 0) > 0
         THEN (COALESCE(SUM(f.earnings), 0) / SUM(f.impressions) * 1000)::real
         ELSE 0 END,
       COALESCE(MAX(a.currency_code), 'USD'),
       NOW()
     FROM adsense_report_daily f
     LEFT JOIN adsense_accounts a ON a.id = f.account_id
     WHERE f.client_id = $1::uuid
       AND f.report_date >= $2::date AND f.report_date <= $3::date
       ${accountClause}
     GROUP BY f.client_id, f.account_id, f.report_date
     ON CONFLICT (client_id, account_id, report_date) DO UPDATE SET
       earnings = EXCLUDED.earnings,
       page_views = EXCLUDED.page_views,
       impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks,
       ctr = EXCLUDED.ctr,
       rpm = EXCLUDED.rpm,
       ecpm = EXCLUDED.ecpm,
       currency = EXCLUDED.currency,
       synced_at = EXCLUDED.synced_at`,
    params
  );
  const n = res.rowCount || 0;
  if (n) logger.info(`[adsense-rollup] rebuilt ${n} day(s) client=${String(clientId).slice(0, 8)}`);
  return n;
}

async function sumAdMobRollup(clientId, { accountId = null, startDate, endDate } = {}) {
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
       COALESCE(SUM(matched_requests), 0)::bigint AS matched_requests,
       CASE WHEN COALESCE(SUM(impressions), 0) > 0
         THEN (SUM(clicks)::float8 / SUM(impressions) * 100) ELSE 0 END AS ctr,
       CASE WHEN COALESCE(SUM(impressions), 0) > 0
         THEN (SUM(earnings) / SUM(impressions) * 1000) ELSE 0 END AS ecpm,
       CASE WHEN COALESCE(SUM(ad_requests), 0) > 0
         THEN (SUM(matched_requests)::float8 / SUM(ad_requests) * 100) ELSE 0 END AS match_rate,
       COALESCE(MAX(currency), 'USD') AS currency
     FROM admob_rollup_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}`,
    params
  );
  return rows[0] || {
    earnings: 0, impressions: 0, clicks: 0, ad_requests: 0, matched_requests: 0,
    ctr: 0, ecpm: 0, match_rate: 0, currency: 'USD',
  };
}

async function trendAdMobRollup(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT report_date::text AS date,
            SUM(earnings)::float AS earnings,
            SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks,
            CASE WHEN COALESCE(SUM(impressions), 0) > 0
              THEN (SUM(earnings) / SUM(impressions) * 1000) ELSE 0 END AS ecpm,
            CASE WHEN COALESCE(SUM(impressions), 0) > 0
              THEN (SUM(clicks)::float8 / SUM(impressions) * 100) ELSE 0 END AS ctr,
            CASE WHEN COALESCE(SUM(ad_requests), 0) > 0
              THEN (SUM(matched_requests)::float8 / SUM(ad_requests) * 100) ELSE 0 END AS match_rate
     FROM admob_rollup_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}
     GROUP BY report_date
     ORDER BY report_date ASC`,
    params
  );
  return rows;
}

async function sumAdSenseRollup(clientId, { accountId = null, startDate, endDate } = {}) {
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
       COALESCE(SUM(clicks), 0)::bigint AS clicks,
       CASE WHEN COALESCE(SUM(impressions), 0) > 0
         THEN (SUM(clicks)::float8 / SUM(impressions) * 100) ELSE 0 END AS ctr,
       CASE WHEN COALESCE(SUM(page_views), 0) > 0
         THEN (SUM(earnings) / SUM(page_views) * 1000) ELSE 0 END AS rpm,
       CASE WHEN COALESCE(SUM(impressions), 0) > 0
         THEN (SUM(earnings) / SUM(impressions) * 1000) ELSE 0 END AS ecpm,
       COALESCE(MAX(currency), 'USD') AS currency
     FROM adsense_rollup_daily
     WHERE client_id = $1
       AND report_date >= $2::date AND report_date <= $3::date
       ${accountClause}`,
    params
  );
  return rows[0] || {
    earnings: 0, page_views: 0, impressions: 0, clicks: 0,
    ctr: 0, rpm: 0, ecpm: 0, currency: 'USD',
  };
}

async function trendAdSenseRollup(clientId, { accountId = null, startDate, endDate } = {}) {
  const params = [clientId, startDate, endDate];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT report_date::text AS date,
            SUM(earnings)::float AS earnings,
            SUM(page_views)::bigint AS page_views,
            SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks,
            CASE WHEN COALESCE(SUM(page_views), 0) > 0
              THEN (SUM(earnings) / SUM(page_views) * 1000) ELSE 0 END AS rpm,
            CASE WHEN COALESCE(SUM(impressions), 0) > 0
              THEN (SUM(clicks)::float8 / SUM(impressions) * 100) ELSE 0 END AS ctr
     FROM adsense_rollup_daily
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
  rebuildAdMobRollups,
  rebuildAdSenseRollups,
  sumAdMobRollup,
  trendAdMobRollup,
  sumAdSenseRollup,
  trendAdSenseRollup,
};
