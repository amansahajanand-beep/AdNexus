/**
 * Read-only: compare per-day, per-app numbers stored in report_grain (slice app_id)
 * against a fresh live GAM report, for every active client.
 *
 * Usage (run on a server that has the GAM credentials in .env):
 *   node scripts/compare-app-vs-gam.js --start 2026-11-09 --end 2026-11-15
 *   node scripts/compare-app-vs-gam.js --start 2026-11-09 --end 2026-11-15 --client mediamonetix
 *
 * It only reads: GAM report API + SELECTs. Nothing is written.
 */
require('dotenv').config();
const { query } = require('../src/db');
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { getToken, buildDateXML, runReportAndDownload } = require('../src/gam/reportTransport');

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const START = arg('start');
const END = arg('end');
const ONLY = arg('client').toLowerCase();
const TOP = parseInt(arg('top', '25'), 10) || 25;
const money = (n) => (Number(n) || 0).toFixed(2);
const micros = (raw) => (parseFloat(raw) || 0) / 1e6;

async function liveGam(start, end) {
  const token = await getToken();
  const xml = `
    <dimensions>DATE</dimensions>
    <dimensions>MOBILE_APP_RESOLVED_ID</dimensions>
    <columns>TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE</columns>
    <columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns>
    ${buildDateXML(start, end)}
    <dateRangeType>CUSTOM_DATE</dateRangeType>`;
  const raw = await runReportAndDownload(xml, token);
  const out = new Map();
  for (const row of raw || []) {
    const day = String(row['Dimension.DATE'] || '').slice(0, 10);
    const app = String(row['Dimension.MOBILE_APP_RESOLVED_ID'] || '').trim().toLowerCase();
    if (!day) continue;
    const key = `${day}|${app}`;
    const cur = out.get(key) || { cpmcpc: 0, all: 0, imps: 0 };
    // GAM report CSV money columns are always micros (1e-6 of the currency). Do not guess units.
    cur.cpmcpc += micros(row['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE']);
    cur.all += micros(row['Column.TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE']);
    cur.imps += parseInt(row['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0, 10) || 0;
    out.set(key, cur);
  }
  return out;
}

async function stored(clientId, start, end) {
  const { rows } = await query(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS day, lower(app_id) AS app,
            SUM(revenue) AS revenue, SUM(impressions) AS imps
     FROM report_grain
     WHERE client_id = $1::uuid AND slice_key = 'app_id'
       AND report_date BETWEEN $2::date AND $3::date
     GROUP BY 1, 2`,
    [clientId, start, end]
  );
  const out = new Map();
  for (const r of rows) out.set(`${r.day}|${r.app}`, { revenue: Number(r.revenue) || 0, imps: Number(r.imps) || 0 });
  return out;
}

async function main() {
  if (!START || !END) {
    console.error('Usage: node scripts/compare-app-vs-gam.js --start YYYY-MM-DD --end YYYY-MM-DD [--client name] [--top N]');
    process.exit(1);
  }
  const clients = (await listActiveClients()).filter((c) => !ONLY || String(c.name || '').toLowerCase().includes(ONLY));
  for (const client of clients) {
    await runWithClient(client, async () => {
      console.log(`\n===== ${client.name} (${String(client.id).slice(0, 8)}) ${START}..${END}`);
      let gam;
      try {
        gam = await liveGam(START, END);
      } catch (e) {
        console.log(`  skipped: GAM report failed: ${e.message}`);
        return;
      }
      const db = await stored(client.id, START, END);
      const keys = new Set([...gam.keys(), ...db.keys()]);
      let tDb = 0; let tCpm = 0; let tAll = 0; let missingInDb = 0; let extraInDb = 0; let bad = 0;
      const diffs = [];
      for (const k of keys) {
        const g = gam.get(k) || { cpmcpc: 0, all: 0, imps: 0 };
        const d = db.get(k) || { revenue: 0, imps: 0 };
        tDb += d.revenue; tCpm += g.cpmcpc; tAll += g.all;
        const delta = d.revenue - g.cpmcpc;
        if (!db.has(k) && g.cpmcpc > 0.005) missingInDb += 1;
        if (!gam.has(k) && d.revenue > 0.005) extraInDb += 1;
        if (Math.abs(delta) >= 0.01) {
          bad += 1;
          const [day, app] = k.split('|');
          diffs.push({ day, app: app || '(blank)', gam_cpm_cpc: money(g.cpmcpc), gam_all: money(g.all), db: money(d.revenue), db_minus_gam: money(delta), gam_imps: Math.round(g.imps), db_imps: Math.round(d.imps) });
        }
      }
      console.log(`  GAM  CPM+CPC revenue : ${money(tCpm)}   (what the dashboard stores)`);
      console.log(`  GAM  ALL revenue     : ${money(tAll)}`);
      console.log(`  DB   stored revenue  : ${money(tDb)}   diff vs CPM+CPC = ${money(tDb - tCpm)}`);
      console.log(`  day/app rows compared: ${keys.size}, differing by >= $0.01: ${bad}, missing in DB: ${missingInDb}, only in DB: ${extraInDb}`);
      diffs.sort((a, b) => Math.abs(b.db_minus_gam) - Math.abs(a.db_minus_gam));
      if (diffs.length) console.table(diffs.slice(0, TOP));
      else console.log('  all rows match to the cent');
    });
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
