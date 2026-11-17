/**
 * Read-only layered audit: where does stored revenue stop matching GAM?
 *
 * For every active client, over a date range (default: 60 days ending 2 days ago):
 *   GAM live total (DATE)  vs  rollup_network_daily  vs  report_grain slices
 *   (inventory_core, app_id, inventory_site_domain, channel, rich_core)
 *   GAM live by SITE_NAME  vs  inventory_core grouped by site
 *   GAM live by app id     vs  app_id slice grouped by app
 *
 * Usage (on a server with GAM credentials in .env):
 *   node scripts/audit-revenue-layers.js
 *   node scripts/audit-revenue-layers.js --days 60 --end 2026-11-15 --client mediamonetix --verbose
 *
 * Only reads: GAM report API + SELECTs. Nothing is written.
 */
require('dotenv').config();
const { query } = require('../src/db');
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');
const { getToken, buildDateXML, runReportAndDownload } = require('../src/gam/reportTransport');

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const DAYS = Math.min(120, Math.max(1, parseInt(arg('days', '60'), 10) || 60));
const END = arg('end') || shiftYMD(todayInTZ(), -2);
const START = shiftYMD(END, -(DAYS - 1));
const ONLY = arg('client').toLowerCase();
const TOP = parseInt(arg('top', '15'), 10) || 15;
const VERBOSE = flag('verbose');

const micros = (raw) => (parseFloat(raw) || 0) / 1e6;
const m2 = (n) => (Number(n) || 0).toFixed(2);
const BLANK = new Set(['', '-', '(not applicable)', 'not applicable', '(none)', '(unknown)']);
const norm = (v) => {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return BLANK.has(s) ? '(blank)' : s;
};
const off = (db, gam) => Math.abs(db - gam) >= Math.max(1, 0.002 * Math.abs(gam)); // >= $1 and > 0.2%

async function gam(dims, start, end) {
  const token = await getToken();
  const dimXml = dims.map((d) => `<dimensions>${d}</dimensions>`).join('');
  const xml = `${dimXml}
    <columns>TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE</columns>
    ${buildDateXML(start, end)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
  return (await runReportAndDownload(xml, token)) || [];
}

function groupRows(rows, keyDims) {
  const out = new Map();
  for (const r of rows) {
    const day = String(r['Dimension.DATE'] || '').slice(0, 10);
    if (!day) continue;
    const key = [day, ...keyDims.map((d) => norm(r[`Dimension.${d}`]))].join('|');
    out.set(key, (out.get(key) || 0) + micros(r['Column.TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE']));
  }
  return out;
}

function compareMaps(gamMap, dbMap) {
  const keys = new Set([...gamMap.keys(), ...dbMap.keys()]);
  let gamTotal = 0; let absErr = 0; let netErr = 0; let bad = 0;
  const byName = new Map();
  for (const k of keys) {
    const g = gamMap.get(k) || 0;
    const d = dbMap.get(k) || 0;
    gamTotal += g; absErr += Math.abs(d - g); netErr += d - g;
    if (off(d, g)) bad += 1;
    const name = k.split('|').slice(1).join('|') || '(total)';
    const cur = byName.get(name) || { name, gam: 0, db: 0, absDiff: 0 };
    cur.gam += g; cur.db += d; cur.absDiff += Math.abs(d - g);
    byName.set(name, cur);
  }
  const top = [...byName.values()].sort((a, b) => b.absDiff - a.absDiff).slice(0, TOP)
    .map((r) => ({ name: r.name, gam: m2(r.gam), db: m2(r.db), db_minus_gam: m2(r.db - r.gam), abs_error: m2(r.absDiff) }));
  return { gamTotal, absErr, netErr, bad, rows: keys.size, top };
}

async function main() {
  const clients = (await listActiveClients()).filter((c) => !ONLY || String(c.name || '').toLowerCase().includes(ONLY));
  console.log(`Audit window ${START} .. ${END} (${DAYS} days)`);
  for (const client of clients) {
    await runWithClient(client, async () => {
      console.log(`\n==================== ${client.name} (${String(client.id).slice(0, 8)})`);
      let gTotal; let gSite; let gApp;
      try {
        gTotal = groupRows(await gam(['DATE'], START, END), []);
        gSite = groupRows(await gam(['DATE', 'SITE_NAME'], START, END), ['SITE_NAME']);
        gApp = groupRows(await gam(['DATE', 'MOBILE_APP_RESOLVED_ID'], START, END), ['MOBILE_APP_RESOLVED_ID']);
      } catch (e) {
        console.log(`  skipped: GAM report failed: ${e.message}`);
        return;
      }

      // ---- stored layers
      const net = new Map();
      (await query(`SELECT to_char(report_date,'YYYY-MM-DD') AS day, revenue FROM rollup_network_daily
                    WHERE client_id=$1::uuid AND report_date BETWEEN $2::date AND $3::date`, [client.id, START, END]))
        .rows.forEach((r) => net.set(`${r.day}`, Number(r.revenue) || 0));

      const slices = new Map(); // slice -> Map(day -> revenue)
      (await query(`SELECT to_char(report_date,'YYYY-MM-DD') AS day, slice_key, SUM(revenue) AS revenue
                    FROM report_grain WHERE client_id=$1::uuid AND report_date BETWEEN $2::date AND $3::date
                    GROUP BY 1,2`, [client.id, START, END]))
        .rows.forEach((r) => {
          if (!slices.has(r.slice_key)) slices.set(r.slice_key, new Map());
          slices.get(r.slice_key).set(r.day, Number(r.revenue) || 0);
        });

      const siteDb = new Map();
      (await query(`SELECT to_char(g.report_date,'YYYY-MM-DD') AS day, COALESCE(s.name,'') AS site, SUM(g.revenue) AS revenue
                    FROM report_grain g LEFT JOIN dim_site s ON s.id = g.site_id
                    WHERE g.client_id=$1::uuid AND g.slice_key='inventory_core' AND g.report_date BETWEEN $2::date AND $3::date
                    GROUP BY 1,2`, [client.id, START, END]))
        .rows.forEach((r) => { const k = `${r.day}|${norm(r.site)}`; siteDb.set(k, (siteDb.get(k) || 0) + (Number(r.revenue) || 0)); });

      const appDb = new Map();
      (await query(`SELECT to_char(report_date,'YYYY-MM-DD') AS day, lower(app_id) AS app, SUM(revenue) AS revenue
                    FROM report_grain WHERE client_id=$1::uuid AND slice_key='app_id'
                      AND report_date BETWEEN $2::date AND $3::date GROUP BY 1,2`, [client.id, START, END]))
        .rows.forEach((r) => { const k = `${r.day}|${norm(r.app)}`; appDb.set(k, (appDb.get(k) || 0) + (Number(r.revenue) || 0)); });

      // ---- A. per-day totals through every layer
      const layers = ['inventory_core', 'app_id', 'inventory_site_domain', 'channel', 'rich_core'];
      const dayRows = [];
      const wrong = { network_rollup: 0 };
      layers.forEach((l) => { wrong[l] = 0; });
      for (const [key, g] of [...gTotal.entries()].sort()) {
        const day = key.split('|')[0];
        const row = { day, gam_total: m2(g), network_rollup: m2(net.get(day) || 0) };
        let any = false;
        if (off(net.get(day) || 0, g)) { wrong.network_rollup += 1; any = true; }
        for (const l of layers) {
          const v = (slices.get(l) && slices.get(l).get(day)) || 0;
          row[l] = m2(v);
          if (v > 0 && off(v, g)) { wrong[l] += 1; any = true; }
          if (v === 0 && slices.has(l) === false) row[l] = '-';
        }
        if (any || VERBOSE) dayRows.push(row);
      }
      const nDays = gTotal.size;
      console.log(`\n  A) Daily total revenue: GAM vs each stored layer (rows shown differ by >= $1 and 0.2%${VERBOSE ? ', all days' : ''})`);
      if (dayRows.length) console.table(dayRows); else console.log('  every day matches in every layer');
      console.log(`  days off by layer (of ${nDays}): ` + Object.entries(wrong).map(([k, v]) => `${k}=${v}`).join('  '));

      // ---- B / C. site and app level
      const s = compareMaps(gSite, siteDb);
      console.log(`\n  B) SITE revenue per day (GAM by SITE_NAME vs stored inventory_core): GAM total ${m2(s.gamTotal)}, `
        + `net error ${m2(s.netErr)}, absolute error ${m2(s.absErr)} (${s.gamTotal ? ((100 * s.absErr) / s.gamTotal).toFixed(2) : '0'}%), `
        + `${s.bad} of ${s.rows} day/site rows off`);
      if (s.top.length) console.table(s.top);
      const a = compareMaps(gApp, appDb);
      console.log(`\n  C) APP ID revenue per day (GAM vs stored app_id slice): GAM total ${m2(a.gamTotal)}, `
        + `net error ${m2(a.netErr)}, absolute error ${m2(a.absErr)} (${a.gamTotal ? ((100 * a.absErr) / a.gamTotal).toFixed(2) : '0'}%), `
        + `${a.bad} of ${a.rows} day/app rows off`);
      if (a.top.length) console.table(a.top);
    });
  }
  console.log('\nHow to read: if network_rollup is off but a slice is right, the rollup rebuild is the problem;');
  console.log('if a slice is off, that slice was not refreshed after GAM revised the day (see the day list);');
  console.log('if only B or C is off but totals match, revenue is attributed to different sites/apps than GAM.');
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
