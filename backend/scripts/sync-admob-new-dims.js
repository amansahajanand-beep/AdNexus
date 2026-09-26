/**
 * One-shot: sync new AdMob mediation dims via standalone pool (no app query/RLS).
 */
require('dotenv').config();
const { Pool } = require('pg');
const { google } = require('googleapis');
const { decryptSecret } = require('../src/utils/credentialsCrypto');

const pool = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: +process.env.PG_PORT || 5432,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  connectionTimeoutMillis: 8000,
  statement_timeout: 60000,
});

const DIMS = ['AD_UNIT', 'AD_SOURCE', 'AD_SOURCE_INSTANCE', 'MEDIATION_GROUP'];
const DIM_KIND = {
  AD_UNIT: 'ad_unit',
  AD_SOURCE: 'ad_source',
  AD_SOURCE_INSTANCE: 'ad_source_instance',
  MEDIATION_GROUP: 'mediation_group',
};
const METRICS = ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'CLICKS', 'AD_REQUESTS', 'MATCHED_REQUESTS'];

function ymdParts(ymd) {
  const [y, m, d] = String(ymd).split('-').map((n) => parseInt(n, 10));
  return { year: y, month: m, day: d };
}
function shiftYMD(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function todayInTZ(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function parseYmd(dateVal) {
  if (!dateVal || typeof dateVal !== 'object') return null;
  const y = dateVal.year ?? dateVal.Year;
  const m = dateVal.month ?? dateVal.Month;
  const d = dateVal.day ?? dateVal.Day;
  if (y && m && d) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return null;
}
function earningsFromMetric(earn = {}) {
  const micros = earn.microsValue ?? earn.micros_value;
  if (micros != null && micros !== '') return Number(micros) / 1e6;
  const decimal = earn.decimalValue ?? earn.decimal_value;
  if (decimal != null && decimal !== '') {
    const n = Number(decimal);
    if (!Number.isFinite(n)) return 0;
    if (Math.abs(n) >= 1000 || Number.isInteger(n)) return n / 1e6;
    return n;
  }
  return 0;
}
function toChunkList(resData) {
  if (resData == null) return [];
  if (Array.isArray(resData)) return resData;
  if (typeof resData === 'string') {
    const trimmed = resData.trim();
    if (!trimmed) return [];
    try { if (trimmed.startsWith('[')) return toChunkList(JSON.parse(trimmed)); } catch { /* */ }
    try { return toChunkList(JSON.parse(`[${trimmed.replace(/}\s*{/g, '},{')}]`)); } catch { /* */ }
    return [];
  }
  return [resData];
}
function toRowList(chunk) {
  if (!chunk || typeof chunk !== 'object') return [];
  if (chunk.dimensionValues || chunk.metricValues) return [chunk];
  const raw = chunk.row ?? chunk.rows;
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}
function parseRows(body, dim) {
  const kind = DIM_KIND[dim];
  const out = [];
  for (const chunk of toChunkList(body)) {
    for (const row of toRowList(chunk)) {
      const d = row.dimensionValues || {};
      const m = row.metricValues || {};
      const dateObj = d.DATE || d.Date || d.date;
      const ymd = parseYmd(dateObj?.value || dateObj);
      if (!ymd) continue;
      const rawVal = d[dim]?.displayLabel || d[dim]?.value || '';
      out.push({
        reportDate: ymd,
        dimKind: kind,
        dimValue: String(rawVal || 'Unknown').trim() || 'Unknown',
        earnings: earningsFromMetric(m.ESTIMATED_EARNINGS),
        impressions: Number(m.IMPRESSIONS?.integerValue || 0),
        clicks: Number(m.CLICKS?.integerValue || 0),
        adRequests: Number(m.AD_REQUESTS?.integerValue || 0),
        matchedRequests: Number(m.MATCHED_REQUESTS?.integerValue || 0),
      });
    }
  }
  return out;
}

(async () => {
  const acc = (await pool.query(
    `SELECT id, client_id, account_id, currency_code, reporting_time_zone, google_refresh_token_enc
     FROM admob_accounts LIMIT 1`
  )).rows[0];
  if (!acc?.google_refresh_token_enc) throw new Error('No AdMob account/token');

  const refreshToken = decryptSecret(acc.google_refresh_token_enc);
  const auth = new google.auth.OAuth2(
    process.env.ADMOB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    process.env.ADMOB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: refreshToken });

  const end = todayInTZ(acc.reporting_time_zone || 'Asia/Calcutta');
  const start = shiftYMD(end, -13);
  const parent = `accounts/${acc.account_id}`;
  console.log(`Syncing dims ${start}→${end} for ${acc.account_id}`);

  for (const dim of DIMS) {
    try {
      const reportSpec = {
        dateRange: { startDate: ymdParts(start), endDate: ymdParts(end) },
        dimensions: ['DATE', dim],
        metrics: METRICS,
        localizationSettings: { currencyCode: acc.currency_code || 'USD' },
      };
      const res = await auth.request({
        url: `https://admob.googleapis.com/v1/${parent}/mediationReport:generate`,
        method: 'POST',
        data: { reportSpec },
        responseType: 'text',
      });
      const rows = parseRows(res.data, dim);
      let n = 0;
      for (const r of rows) {
        await pool.query(
          `INSERT INTO admob_dim_daily (
             client_id, account_id, report_date, dim_kind, dim_value,
             earnings, impressions, clicks, ad_requests, matched_requests, updated_at
           ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,now())
           ON CONFLICT (client_id, account_id, report_date, dim_kind, dim_value) DO UPDATE SET
             earnings = EXCLUDED.earnings,
             impressions = EXCLUDED.impressions,
             clicks = EXCLUDED.clicks,
             ad_requests = EXCLUDED.ad_requests,
             matched_requests = EXCLUDED.matched_requests,
             updated_at = now()`,
          [
            acc.client_id, acc.id, r.reportDate, r.dimKind, String(r.dimValue).slice(0, 500),
            r.earnings, r.impressions, r.clicks, r.adRequests, r.matchedRequests,
          ]
        );
        n += 1;
      }
      console.log(`  ${dim}: ${rows.length} parsed → ${n} upserted`);
    } catch (e) {
      const msg = e?.response?.data
        ? (typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data))
        : e.message;
      console.error(`  ${dim} FAILED:`, String(msg).slice(0, 400));
    }
  }

  const counts = await pool.query(
    `SELECT dim_kind, COUNT(*)::int AS n FROM admob_dim_daily WHERE account_id = $1 GROUP BY 1 ORDER BY 1`,
    [acc.id]
  );
  console.log('dim_kind counts:', counts.rows);
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* */ }
  process.exit(1);
});
