/**
 * Audit report_grain (app_id slice) against LIVE GAM over any range, per client.
 * Default is a DRY RUN: it only reads GAM + SELECTs and lists the days that disagree.
 *
 *   node scripts/audit-app-grain.js --start 2026-05-01 --end 2026-10-15
 *   node scripts/audit-app-grain.js --start 2026-05-01 --end 2026-10-15 --client mediamonetix
 *   node scripts/audit-app-grain.js --start 2026-05-01 --end 2026-10-15 --fix --max-fix 200
 *
 * --fix re-syncs each divergent day directly (same code path as the `sync-day` job), worst day first.
 * Re-run without --fix afterwards: it should list no divergent days.
 */
require('dotenv').config();
const { listActiveClients } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { auditClient } = require('../src/services/appGrainAuditService');

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

(async () => {
  const start = arg('start');
  const end = arg('end');
  const only = arg('client').toLowerCase();
  const fix = process.argv.includes('--fix');
  const maxFix = parseInt(arg('max-fix', '400'), 10) || 400;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    console.error('Usage: node scripts/audit-app-grain.js --start YYYY-MM-DD --end YYYY-MM-DD [--client name] [--fix] [--max-fix N]');
    process.exit(1);
  }
  process.env.APP_GRAIN_AUDIT_DAYS = process.env.APP_GRAIN_AUDIT_DAYS || '14';
  const clients = (await listActiveClients()).filter((c) => !only || String(c.name || '').toLowerCase().includes(only));
  for (const client of clients) {
    await runWithClient(client, async () => {
      try {
        const res = await auditClient(client, { start, end, maxFix, dryRun: !fix, inline: true });
        const total = res.divergent.reduce((a, d) => a + d.absDelta, 0);
        console.log(`\n== ${client.name}: ${res.divergent.length} divergent day(s) in ${start}..${end}, total |delta| $${total.toFixed(2)}${fix ? ` — repaired ${res.actions.length}` : ' (dry run)'}`);
        if (res.divergent.length) console.table(res.divergent.slice(0, 40).map((d) => ({ day: d.day, apps_differing: d.apps, sites_differing: d.sites, abs_delta_usd: d.absDelta.toFixed(2) })));
      } catch (e) {
        console.log(`\n== ${client.name}: FAILED ${e.message}`);
      }
    });
  }
  process.exit(0);
})();
