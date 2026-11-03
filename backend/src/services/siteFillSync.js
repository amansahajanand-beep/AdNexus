/**
 * Site-wise total fill rate + total targeted impressions, pulled from GAM into the warehouse.
 *
 * GAM only reports unfilled impressions per ad unit (never per SITE_NAME) and rejects the
 * TOTAL_*TARGETED_IMPRESSIONS columns for every dimension, so:
 *   adunit_fill_daily  = raw DATE x AD_UNIT_NAME pull (impressions, unfilled)
 *   site_fill_daily    = ad units rolled up to the site/domain named in the ad unit
 *                        (same rule as grainDomainExprSql: "<domain>_<slot>" -> domain)
 *   targeted_impressions = impressions + unfilled; fill_rate = impressions / targeted * 100
 * Read by enrichSiteFill in gamSyncService (Reporting). Must run inside runWithClient.
 */
const { query, schemaQuery } = require('../db');
const { getToken, buildDateXML, runReportAndDownload } = require('../gam/reportTransport');
const { requireClientId } = require('../utils/clientContext');
const logger = require('../utils/logger');

const M_IMP = 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS';
const M_UNF = 'TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS';
const WINDOW_DAYS = 14;

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

/** "crmlayers.com_300x250 (123)" -> "crmlayers.com"; null when the name carries no domain. */
function domainOfAdUnit(name) {
  const au = String(name || '').trim();
  if (!/\..+_/.test(au)) return null;
  const root = au.replace(/\s*\(\d+\)\s*$/, '').split('_')[0].trim().toLowerCase();
  return root.includes('.') ? root : null;
}

async function tenantTable(name, cols) {
  await schemaQuery(`CREATE TABLE IF NOT EXISTS ${name} (
      client_id UUID NOT NULL REFERENCES gam_clients(id),
      report_date DATE NOT NULL,
      ${cols}
      impressions DOUBLE PRECISION NOT NULL DEFAULT 0,
      unfilled DOUBLE PRECISION NOT NULL DEFAULT 0,
      targeted_impressions DOUBLE PRECISION NOT NULL DEFAULT 0,
      fill_rate DOUBLE PRECISION,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  const { rows } = await schemaQuery(
    `SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS has_policy
     FROM pg_class c WHERE c.oid = to_regclass($1)`,
    [name]
  );
  if (rows[0]?.on && rows[0]?.forced && rows[0]?.has_policy) return;
  await schemaQuery(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
  await schemaQuery(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`);
  await schemaQuery(`DROP POLICY IF EXISTS tenant_isolation ON ${name}`);
  await schemaQuery(`CREATE POLICY tenant_isolation ON ${name}
    USING (client_id::text = current_setting('app.client_id', true))
    WITH CHECK (client_id::text = current_setting('app.client_id', true))`);
}

let tablesReady = false;
async function ensureSiteFillTables() {
  if (tablesReady) return;
  await tenantTable('adunit_fill_daily', 'ad_unit_name TEXT NOT NULL, site_name TEXT NOT NULL,');
  await schemaQuery('CREATE UNIQUE INDEX IF NOT EXISTS adunit_fill_daily_pk ON adunit_fill_daily (client_id, report_date, ad_unit_name, site_name)');
  await tenantTable('site_fill_daily', 'site_name TEXT NOT NULL,');
  await schemaQuery('CREATE UNIQUE INDEX IF NOT EXISTS site_fill_daily_pk ON site_fill_daily (client_id, report_date, site_name)');
  tablesReady = true;
}

async function pullWindow(token, start, end) {
  const xml = `<dimensions>DATE</dimensions><dimensions>AD_UNIT_NAME</dimensions>
    <columns>${M_IMP}</columns><columns>${M_UNF}</columns>
    ${buildDateXML(start, end)}<dateRangeType>CUSTOM_DATE</dateRangeType>`;
  const rows = await runReportAndDownload(xml, token);
  const out = new Map();
  for (const r of rows) {
    const date = r['Dimension.DATE'];
    const unit = (r['Dimension.AD_UNIT_NAME'] || '').trim();
    if (!date || !unit) continue;
    const k = `${date}|${unit}`;
    const o = out.get(k) || { date, unit, imp: 0, unf: 0 };
    o.imp += num(r[`Column.${M_IMP}`]);
    o.unf += num(r[`Column.${M_UNF}`]);
    out.set(k, o);
  }
  return [...out.values()];
}

const withFill = (imp, unf) => {
  const tgt = imp + unf;
  return [tgt, tgt > 0 ? +((imp / tgt) * 100).toFixed(2) : null];
};

async function insertChunks(table, keyCols, rows) {
  const BATCH = 400;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params = [];
    const ph = chunk.map((r) => {
      const b = params.length;
      params.push(...r);
      return `(${r.map((_, j) => `$${b + j + 1}`).join(',')})`;
    });
    const cols = ['client_id', 'report_date', ...keyCols, 'impressions', 'unfilled', 'targeted_impressions', 'fill_rate'];
    await query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph.join(',')}
       ON CONFLICT (client_id, report_date, ${keyCols.join(',')}) DO UPDATE SET
         impressions = EXCLUDED.impressions, unfilled = EXCLUDED.unfilled,
         targeted_impressions = EXCLUDED.targeted_impressions, fill_rate = EXCLUDED.fill_rate, synced_at = NOW()`,
      params
    );
  }
}

async function store(clientId, units) {
  const unitRows = [];
  const sites = new Map();
  for (const u of units) {
    const site = domainOfAdUnit(u.unit) || '(unknown)';
    const [tgt, fill] = withFill(u.imp, u.unf);
    unitRows.push([clientId, u.date, u.unit, site, u.imp, u.unf, tgt, fill]);
    const k = `${u.date}|${site}`;
    const s = sites.get(k) || { date: u.date, site, imp: 0, unf: 0 };
    s.imp += u.imp; s.unf += u.unf;
    sites.set(k, s);
  }
  const siteRows = [...sites.values()].map((s) => {
    const [tgt, fill] = withFill(s.imp, s.unf);
    return [clientId, s.date, s.site, s.imp, s.unf, tgt, fill];
  });
  await insertChunks('adunit_fill_daily', ['ad_unit_name', 'site_name'], unitRows);
  await insertChunks('site_fill_daily', ['site_name'], siteRows);
  return { units: unitRows.length, sites: siteRows.length };
}

/** Pull startDate..endDate (YYYY-MM-DD) for the current client and upsert. Returns row counts. */
async function syncSiteFill(startDate, endDate) {
  await ensureSiteFillTables();
  const clientId = requireClientId();
  const token = await getToken();
  const total = { units: 0, sites: 0, failed: 0 };
  for (let s = startDate; s <= endDate; s = addDays(s, WINDOW_DAYS)) {
    const e = addDays(s, WINDOW_DAYS - 1) < endDate ? addDays(s, WINDOW_DAYS - 1) : endDate;
    try {
      const n = await store(clientId, await pullWindow(token, s, e));
      total.units += n.units; total.sites += n.sites;
    } catch (err) {
      total.failed += 1;
      logger.warn(`[site-fill] ${s}..${e} failed: ${String(err.message).slice(0, 160)}`);
    }
  }
  return total;
}

module.exports = { syncSiteFill, ensureSiteFillTables, domainOfAdUnit, ymd, addDays };
