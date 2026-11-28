/**
 * Keep repairing report_grain (apps + sites) against LIVE GAM until it matches, worst day first.
 * Runs until two consecutive audit passes find no day worse than --min-delta, then exits.
 *
 *   node scripts/audit-fix-loop.js --client mediamonetix --start 2026-05-01
 *   node scripts/audit-fix-loop.js --client "kgs,bt global,yieldoora,whitearbi" --start 2026-05-01 --min-delta 5
 *
 * Each pass: one dry-run audit (a few GAM reports), then a full `sync-day` re-sync of up to --batch of the
 * worst days (same code path as the queue job). GAM keeps revising recent days, so the loop re-audits after
 * every batch and re-fixes what moved. Safe to stop and restart at any time.
 * Run on the server for speed (each day is ~110k rows; over an SSH tunnel it is ~5 min/day).
 */
require('dotenv').config();
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { auditClient, repairDay } = require('../src/services/appGrainAuditService');

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncDay(client, day) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try { return await repairDay(client, day, true); } catch (e) {
      const yielded = e && (e.yieldToToday || /today[- ]priority/i.test(String(e.message)));
      if (attempt === 6) throw e;
      log(`  ${day}: ${yielded ? "paused for today's sync" : `error ${e.message}`}, retry in 60s (attempt ${attempt})`);
      await sleep(60000);
    }
  }
  return null;
}

async function fixClient(client, { start, end, minDelta, batch }) {
  let clean = 0;
  for (let pass = 1; ; pass += 1) {
    let res;
    try {
      res = await auditClient(client, { start, end: end || undefined, maxFix: 1, dryRun: true });
    } catch (e) {
      log(`${client.name}: audit failed (${e.message}); retry in 5 min`);
      await sleep(300000);
      continue;
    }
    const bad = res.divergent.filter((d) => d.absDelta >= minDelta);
    const total = bad.reduce((a, d) => a + d.absDelta, 0);
    log(`${client.name}: pass ${pass} ${res.start}..${res.end} — ${bad.length} day(s) off by >= $${minDelta} (total |delta| $${total.toFixed(2)})`);
    if (!bad.length) {
      clean += 1;
      if (clean >= 2) { log(`${client.name}: CLEAN (2 consecutive passes)`); return; }
      await sleep(600000); // GAM may still revise: confirm once more after 10 min
      continue;
    }
    clean = 0;
    for (const d of bad.slice(0, batch)) {
      const t0 = Date.now();
      try {
        await syncDay(client, d.day);
        log(`${client.name}: re-synced ${d.day} (was off $${d.absDelta.toFixed(2)}) in ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (e) {
        log(`${client.name}: FAILED ${d.day}: ${e.message}`);
      }
    }
  }
}

(async () => {
  const only = arg('client').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const start = arg('start', '2026-05-01');
  const end = arg('end', '');
  const minDelta = parseFloat(arg('min-delta', '5')) || 5;
  const batch = parseInt(arg('batch', '8'), 10) || 8;
  if (!only.length) { console.error('Usage: node scripts/audit-fix-loop.js --client "<name>[,<name>...]" [--start YYYY-MM-DD] [--min-delta 5] [--batch 8]'); process.exit(1); }
  const clients = (await listActiveClients()).filter((c) => only.some((o) => String(c.name || '').toLowerCase().includes(o)));
  // keep the order given on the command line (priority order)
  clients.sort((a, b) => only.findIndex((o) => a.name.toLowerCase().includes(o)) - only.findIndex((o) => b.name.toLowerCase().includes(o)));
  if (!clients.length) { console.error('No active client matches'); process.exit(1); }
  for (const client of clients) {
    await runWithClient(client, () => fixClient(client, { start, end, minDelta, batch }));
  }
  log('ALL DONE');
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
