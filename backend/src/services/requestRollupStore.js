/**
 * Ad Exchange ad requests / match rate warehouse (rollup_request_daily).
 *
 * GAM returns AD_EXCHANGE_TOTAL_REQUESTS and AD_EXCHANGE_MATCH_RATE (a 0-1 fraction) for every
 * dimension set we use. We pull small per-day reports and store requests + matched requests
 * (requests x rate), so Reporting can show match rate on any date range from a tiny table
 * instead of re-asking GAM or scanning report_grain. Match rate over several days is
 * sum(matched) / sum(requests) - never an average of daily rates.
 *
 * Kinds (key):
 *   ad_unit          ad unit name                   app              LOWER(app id)
 *   country          country name                   ad_unit_country  '<ad unit>|<country>'
 *   app_country      '<LOWER(app id)>|<country>'
 */
const logger = require('../utils/logger');
const { query, withTransaction } = require('../db');
const { requireClientId } = require('../utils/clientContext');

const METRICS = ['AD_EXCHANGE_TOTAL_REQUESTS', 'AD_EXCHANGE_MATCH_RATE'];

function clean(v) {
  return String(v == null ? '' : v).trim();
}
function lowerApp(v) {
  const s = clean(v).toLowerCase();
  return s === '(not applicable)' ? '' : s;
}
function pair(a, b) {
  return a && b ? `${a}|${b}` : '';
}

const PULLS = [
  { kind: 'ad_unit', dims: ['DATE', 'AD_UNIT_NAME'], key: (r) => clean(r['Dimension.AD_UNIT_NAME']) },
  {
    kind: 'app',
    dims: ['DATE', 'MOBILE_APP_RESOLVED_ID'],
    key: (r) => lowerApp(r['Dimension.MOBILE_APP_RESOLVED_ID']),
  },
  { kind: 'country', dims: ['DATE', 'COUNTRY_NAME'], key: (r) => clean(r['Dimension.COUNTRY_NAME']) },
  {
    // Stored by dim id in rollup_unit_country_fill (compact), not as text keys.
    kind: 'ad_unit_country',
    dims: ['DATE', 'COUNTRY_NAME', 'AD_UNIT_NAME'],
    key: (r) => pair(clean(r['Dimension.AD_UNIT_NAME']), clean(r['Dimension.COUNTRY_NAME'])),
    byId: true,
  },
  {
    kind: 'app_country',
    dims: ['DATE', 'COUNTRY_NAME', 'MOBILE_APP_RESOLVED_ID'],
    key: (r) => pair(lowerApp(r['Dimension.MOBILE_APP_RESOLVED_ID']), clean(r['Dimension.COUNTRY_NAME'])),
  },
];

function buildXml(dims, buildDateXML, startDate, endDate) {
  const dimXML = dims.map((d) => `<dimensions>${d}</dimensions>`).join('\n    ');
  const colXML = METRICS.map((c) => `<columns>${c}</columns>`).join('\n    ');
  return `\n    ${dimXML}\n    ${colXML}\n    ${buildDateXML(startDate, endDate)}\n    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
}

function ymdList(startDate, endDate) {
  const out = [];
  const end = new Date(`${endDate}T12:00:00Z`).getTime();
  for (let t = new Date(`${startDate}T12:00:00Z`).getTime(); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Pull one date window from GAM and replace those days in rollup_request_daily. */
async function syncRequestWindow(startDate, endDate) {
  const { getToken, buildDateXML, runReportAndDownload } = require('../gam/reportTransport');
  const clientId = requireClientId();
  const token = await getToken();
  const byKey = new Map(); // day|kind|key -> { req, matched }
  const byId = new Map(); // day|kind|'<ad unit>|<country>' -> { req, matched } (stored by dim id)
  let ok = 0;
  for (const pull of PULLS) {
    try {
      const raw = await runReportAndDownload(buildXml(pull.dims, buildDateXML, startDate, endDate), token, {});
      const rows = Array.isArray(raw) ? raw : [];
      for (const r of rows) {
        const day = clean(r['Dimension.DATE']).slice(0, 10);
        const key = pull.key(r);
        if (!day || !key) continue;
        const req = Number(r['Column.AD_EXCHANGE_TOTAL_REQUESTS']) || 0;
        const rate = Number(r['Column.AD_EXCHANGE_MATCH_RATE']) || 0;
        const k = `${day}|${pull.kind}|${key}`;
        if (pull.byId) {
          const prevId = byId.get(k) || { req: 0, matched: 0 };
          prevId.req += req;
          prevId.matched += req * rate;
          byId.set(k, prevId);
          continue;
        }
        const prev = byKey.get(k) || { req: 0, matched: 0 };
        prev.req += req;
        prev.matched += req * rate;
        byKey.set(k, prev);
      }
      ok += 1;
    } catch (e) {
      logger.warn(`[request-rollup] ${pull.kind} ${startDate}..${endDate} failed: ${String(e.message || e).slice(0, 140)}`);
    }
  }
  if (!ok) throw new Error('GAM returned no request metrics for any dimension set');

  const days = ymdList(startDate, endDate);
  const rows = [...byKey.entries()].map(([k, v]) => {
    const [day, kind, ...rest] = k.split('|');
    return { day, kind, key: rest.join('|'), req: v.req, matched: v.matched };
  });
  await withTransaction(async (q) => {
    await q(
      'DELETE FROM rollup_request_daily WHERE client_id = $1::uuid AND report_date = ANY($2::date[])',
      [clientId, days]
    );
    const CH = 5000;
    for (let i = 0; i < rows.length; i += CH) {
      const part = rows.slice(i, i + CH);
      await q(
        `INSERT INTO rollup_request_daily (client_id, report_date, kind, key, ad_requests, matched_requests)
         SELECT $1::uuid, d, k, ky, r, m
         FROM unnest($2::date[], $3::text[], $4::text[], $5::float8[], $6::float8[]) AS t(d, k, ky, r, m)
         ON CONFLICT (client_id, report_date, kind, key)
         DO UPDATE SET ad_requests = EXCLUDED.ad_requests, matched_requests = EXCLUDED.matched_requests`,
        [
          clientId,
          part.map((x) => x.day),
          part.map((x) => x.kind),
          part.map((x) => x.key),
          part.map((x) => x.req),
          part.map((x) => x.matched),
        ]
      );
    }
  });
  if (byId.size) await storeUnitCountryRequests(clientId, byId);
  return rows.length + byId.size;
}

/** Upsert ad_requests / matched_requests into rollup_unit_country_fill (names -> dim ids). */
async function storeUnitCountryRequests(clientId, byId) {
  const entries = [...byId.entries()].map(([k, v]) => {
    const [day, , ...rest] = k.split('|');
    const key = rest.join('|');
    const i = key.lastIndexOf('|');
    return { day, unit: key.slice(0, i), country: key.slice(i + 1), req: v.req, matched: v.matched };
  });
  const units = [...new Set(entries.map((e) => e.unit))];
  const countries = [...new Set(entries.map((e) => e.country))];
  const [{ rows: uRows }, { rows: cRows }] = await Promise.all([
    query('SELECT id, name FROM dim_ad_unit WHERE client_id = $1::uuid AND name = ANY($2::text[])', [clientId, units]),
    query('SELECT id, name FROM dim_country WHERE name = ANY($1::text[])', [countries]),
  ]);
  const unitId = new Map(uRows.map((r) => [r.name, Number(r.id)]));
  const countryId = new Map(cRows.map((r) => [r.name, Number(r.id)]));
  const rows = entries
    .map((e) => ({ ...e, u: unitId.get(e.unit), c: countryId.get(e.country) }))
    .filter((e) => e.u && e.c);
  const CH = 5000;
  for (let i = 0; i < rows.length; i += CH) {
    const part = rows.slice(i, i + CH);
    await query(
      `INSERT INTO rollup_unit_country_fill (client_id, report_date, ad_unit_id, country_id, ad_requests, matched_requests)
       SELECT $1::uuid, d, u, c, r, m
       FROM unnest($2::date[], $3::int[], $4::int[], $5::float8[], $6::float8[]) AS t(d, u, c, r, m)
       ON CONFLICT (client_id, report_date, ad_unit_id, country_id)
       DO UPDATE SET ad_requests = EXCLUDED.ad_requests, matched_requests = EXCLUDED.matched_requests`,
      [clientId, part.map((x) => x.day), part.map((x) => x.u), part.map((x) => x.c),
        part.map((x) => x.req), part.map((x) => x.matched)]
    );
  }
}

/** Sync a list of days in windows of up to `windowDays` (GAM returns DATE-keyed rows). */
async function syncRequestDays(dates, { windowDays = 7, pauseMs = 0 } = {}) {
  const sorted = [...new Set(dates)].sort();
  let n = 0;
  for (let i = 0; i < sorted.length; i += windowDays) {
    const part = sorted.slice(i, i + windowDays);
    // Backfill windows wait for a quiet moment (no report running) before hitting GAM + Postgres.
    if (pauseMs > 0) await require('../utils/activityGate').waitForQuiet();
    try {
      n += await syncRequestWindow(part[0], part[part.length - 1]);
    } catch (e) {
      logger.warn(`[request-rollup] window ${part[0]}..${part[part.length - 1]} failed: ${e.message}`);
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return n;
}

let backfillRunning = false;
/** Background: build request rollups for the last N days that have none (newest first). */
async function backfillRequestRollups(days = parseInt(process.env.REQUEST_ROLLUP_BACKFILL_DAYS || '180', 10) || 180) {
  if (backfillRunning) return 0;
  backfillRunning = true;
  try {
    const clientId = requireClientId();
    const { rows } = await query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS d
       FROM generate_series(CURRENT_DATE - $2::int, CURRENT_DATE, '1 day'::interval) AS d(day)
       WHERE NOT EXISTS (
         SELECT 1 FROM rollup_unit_country_fill r
         WHERE r.client_id = $1::uuid AND r.report_date = d.day::date AND r.ad_requests IS NOT NULL
       )
       ORDER BY d.day DESC`,
      [clientId, days]
    );
    const dates = rows.map((r) => r.d);
    if (!dates.length) return 0;
    logger.info(`[request-rollup] backfilling ${dates.length} day(s) client=${String(clientId).slice(0, 8)}`);
    const n = await syncRequestDays(dates, {
      pauseMs: Math.max(0, parseInt(process.env.REQUEST_BACKFILL_PAUSE_MS || '3000', 10) || 0),
    });
    logger.info(`[request-rollup] backfill done (${n} row(s)) client=${String(clientId).slice(0, 8)}`);
    return n;
  } catch (e) {
    logger.warn('[request-rollup] backfill failed:', e.message);
    return 0;
  } finally {
    backfillRunning = false;
  }
}

/** Hourly: refresh today + the previous days (GAM revises recent days). */
async function refreshRecentRequestRollups(days = 3) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return syncRequestDays(ymdList(start, end), { windowDays: days });
}

/**
 * ad unit x country by dim id: Map `${day}|${unit}|${country}` -> { fillImp, unfilled, req, matched }.
 * One indexed range read (client, ad unit id, date) instead of thousands of text-key probes.
 */
async function lookupUnitCountryExtras(pairKeys, startDate, endDate) {
  const out = new Map();
  if (!pairKeys.length) return out;
  const clientId = requireClientId();
  const parsed = pairKeys.map((k) => {
    const i = k.lastIndexOf('|');
    return { unit: k.slice(0, i), country: k.slice(i + 1) };
  });
  const units = [...new Set(parsed.map((p) => p.unit))];
  const countries = [...new Set(parsed.map((p) => p.country))];
  const [{ rows: uRows }, { rows: cRows }] = await Promise.all([
    query('SELECT id, name FROM dim_ad_unit WHERE client_id = $1::uuid AND name = ANY($2::text[])', [clientId, units]),
    query('SELECT id, name FROM dim_country WHERE name = ANY($1::text[])', [countries]),
  ]);
  if (!uRows.length || !cRows.length) return out;
  const unitName = new Map(uRows.map((r) => [Number(r.id), r.name]));
  const countryName = new Map(cRows.map((r) => [Number(r.id), r.name]));
  const { rows } = await query(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS d, ad_unit_id, country_id,
            fill_impressions, unfilled, ad_requests, matched_requests
     FROM rollup_unit_country_fill
     WHERE client_id = $1::uuid AND ad_unit_id = ANY($2::int[])
       AND report_date BETWEEN $3::date AND $4::date AND country_id = ANY($5::int[])`,
    [clientId, [...unitName.keys()], startDate, endDate, [...countryName.keys()]]
  ).catch(() => ({ rows: [] }));
  for (const r of rows) {
    out.set(`${r.d}|${unitName.get(Number(r.ad_unit_id))}|${countryName.get(Number(r.country_id))}`, {
      fillImp: Number(r.fill_impressions) || 0,
      unfilled: r.unfilled == null ? null : Number(r.unfilled),
      req: r.ad_requests == null ? null : Number(r.ad_requests),
      matched: r.matched_requests == null ? null : Number(r.matched_requests),
    });
  }
  return out;
}

/** Per (day|key) requests / matched for one kind. */
async function lookupRequestTotals(kind, keys, startDate, endDate) {
  const out = new Map();
  if (!keys.length) return out;
  if (kind === 'ad_unit_country') {
    const extras = await lookupUnitCountryExtras(keys, startDate, endDate);
    for (const [k, v] of extras) {
      if (v.req != null) out.set(k, { req: v.req, matched: v.matched || 0 });
    }
    return out;
  }
  // Exact day list (not BETWEEN) so the primary key (client, date, kind, key) is used directly.
  const days = ymdList(startDate, endDate);
  const { rows } = await query(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS d, key, ad_requests AS req, matched_requests AS matched
     FROM rollup_request_daily
     WHERE client_id = $1::uuid AND kind = $2 AND report_date = ANY($3::date[])
       AND key = ANY($4::text[])`,
    [requireClientId(), kind, days, keys]
  ).catch(() => ({ rows: [] }));
  for (const r of rows) out.set(`${r.d}|${r.key}`, { req: Number(r.req) || 0, matched: Number(r.matched) || 0 });
  return out;
}

function applyRequests(row, hit) {
  if (!hit || !(hit.req > 0)) return;
  const pct = +((hit.matched / hit.req) * 100).toFixed(2);
  row.adRequests = Math.round(hit.req);
  row.matchedRequests = Math.round(hit.matched);
  row.adxMatchRate = pct;
  row.metrics = {
    ...(row.metrics || {}),
    ad_exchange_total_requests: Math.round(hit.req),
    ad_exchange_match_rate: pct,
  };
}

/**
 * Fill Ad Exchange total requests / match rate on report rows (per day) from rollup_request_daily.
 * Row grain -> kind: ad unit [x country], app [x country], country only. Device rows are skipped.
 */
async function enrichRequestMetrics(rows = [], startDate, endDate) {
  const isApp = (v) => v && v !== '—' && v !== '-' && v !== '–';
  const unitOf = (r) => String(r.AD_UNIT_NAME || r.ad_unit_name || '').trim();
  const dayOf = (r) => String(r.date || r.report_date || '').slice(0, 10);
  const countryOf = (r) => String(r.country || '').trim();
  const appOf = (r) => (isApp(r.appId) ? String(r.appId).trim().toLowerCase() : '');
  const open = (rows || []).filter((r) => r.adRequests == null && !r.device);
  const plan = (r) => {
    const u = unitOf(r);
    const a = appOf(r);
    const c = countryOf(r);
    if (u) return c ? ['ad_unit_country', `${u}|${c}`] : ['ad_unit', u];
    if (a) return c ? ['app_country', `${a}|${c}`] : ['app', a];
    if (c) return ['country', c];
    return null;
  };
  const byKind = new Map();
  for (const r of open) {
    const p = plan(r);
    if (!p) continue;
    if (!byKind.has(p[0])) byKind.set(p[0], new Set());
    byKind.get(p[0]).add(p[1]);
  }
  const lookups = new Map();
  await Promise.all([...byKind.entries()].map(async ([kind, set]) => {
    lookups.set(kind, await lookupRequestTotals(kind, [...set], startDate, endDate));
  }));
  for (const r of open) {
    const p = plan(r);
    if (!p) continue;
    applyRequests(r, lookups.get(p[0]).get(`${dayOf(r)}|${p[1]}`));
  }
}

module.exports = {
  lookupUnitCountryExtras,
  syncRequestDays,
  backfillRequestRollups,
  refreshRecentRequestRollups,
  enrichRequestMetrics,
};
