/**
 * Read-only: explains why a domain user's numbers differ between "all sites" and single sites, or between the
 * network's own timezone and another timezone. Nothing is written.
 *
 *   node scripts/diagnose-tz-scope.js --user <username> --start 2026-11-17 --end 2026-11-22 [--tz Asia/Kolkata] [--network a6a80cdd]
 *
 * For each network the user can open it prints:
 *   1. coverage     - which local days of the chosen timezone the stored hourly data can serve, per slice
 *   2. accuracy     - hourly data viewed in the network's OWN timezone vs the normal daily rollups for the same scope
 *                     (if these differ the hourly data itself is off, not the timezone maths)
 *   3. consistency  - "all assigned" vs the sum of every single site / domain / app, in the chosen timezone
 */
require('dotenv').config();
const db = require('../src/db');
const hv = require('../src/services/hourlyView');
const { shiftYMD, todayInTZ } = require('../src/utils/datetime');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b ? `${(((a - b) / b) * 100).toFixed(2)}%` : (a ? 'n/a' : '0.00%'));
const flag = (a, b) => (Math.abs(a - b) > Math.max(0.5, Math.abs(b) * 0.005) ? '  <-- DIFFERS' : '');

/** Revenue + impressions for one resolved scope, exactly the way the timezone view builds its trend. */
async function hourlyTotals(base, scope) {
  const domains = scope.domains || [];
  const sites = scope.sites || [];
  const apps = scope.apps || [];
  const parts = await Promise.all([
    (domains.length || sites.length)
      ? hv.hourlyTrend({ ...base, kind: 'inventory', filter: { domains, sites, scoped: true, webOr: Boolean(scope.webInventoryOr) } })
      : [],
    apps.length ? hv.hourlyTrend({ ...base, kind: 'app', filter: { apps } }) : [],
  ]);
  let revenue = 0;
  let impressions = 0;
  for (const d of parts.flat()) { revenue += d.earning; impressions += d.impressions; }
  return { revenue, impressions };
}

(async () => {
  const username = arg('user');
  const startDate = arg('start');
  const endDate = arg('end');
  if (!username || !startDate || !endDate) {
    console.log('usage: node scripts/diagnose-tz-scope.js --user <username> --start YYYY-MM-DD --end YYYY-MM-DD [--tz Asia/Kolkata] [--network <id prefix>]');
    process.exit(1);
  }
  const tz = arg('tz', 'Asia/Kolkata');
  if (!hv.isValidTz(tz)) { console.log(`invalid timezone: ${tz}`); process.exit(1); }
  const onlyNetwork = arg('network');

  const { getUserById } = require('../src/models/userStore');
  const { getAllowedClientIds, getUserInventoryScope, resolveScopedSqlInventoryOpts } = require('../src/utils/permissions');
  const { getClientById } = require('../src/models/clientStore');
  const { getNetworkTz } = require('../src/services/networkTimezone');
  const { runWithClient } = require('../src/utils/clientContext');
  const svc = require('../src/services/gamSyncService');

  const row = (await db.query('SELECT id FROM users WHERE username = $1', [username])).rows[0];
  if (!row) { console.log(`user not found: ${username}`); process.exit(1); }
  const user = await getUserById(row.id);
  const inv = getUserInventoryScope(user);
  if (!inv) { console.log('this user is an admin (no assigned scope) - run it for a domain user'); process.exit(0); }

  let networkIds = getAllowedClientIds(user) || [user.clientId];
  if (onlyNetwork) networkIds = networkIds.filter((id) => String(id).startsWith(onlyNetwork));

  const sites = [...(inv.sites || [])];
  const domains = [...(inv.domains || [])];
  const apps = [...(inv.appIds || [])];
  const scopeAll = resolveScopedSqlInventoryOpts(user, {});
  console.log(`user=${username} range=${startDate}..${endDate} viewing tz=${tz}`);
  console.log(`assigned: ${domains.length} domains, ${sites.length} sites, ${apps.length} apps | networks: ${networkIds.length}`);
  console.log(`"all" resolves to: domains=${scopeAll.domains.length} sites=${scopeAll.sites.length} apps=${scopeAll.apps.length} webOr=${scopeAll.webInventoryOr}`);

  const grand = { all: 0, sumSites: 0, sumDomains: 0, apps: 0, normal: 0, ownTz: 0 };

  for (const id of networkIds) {
    const client = await getClientById(id);
    if (!client) { console.log(`\n[${String(id).slice(0, 8)}] network not found`); continue; }
    const srcTz = await getNetworkTz(client);
    console.log(`\n=== ${client.name} [${String(id).slice(0, 8)}] network tz=${srcTz} ===`);

    // 1. coverage per slice
    const today = todayInTZ(tz);
    const cov = {};
    for (const kind of ['network', 'inventory', 'app']) {
      const c = await hv.coverage(id, tz, today, srcTz, Date.now(), kind);
      cov[kind] = c;
      console.log(`coverage[${kind}]: ${c ? `${c.from}..${c.through}${c.partialDay ? ` (partial ${c.partialDay})` : ''}` : 'NONE'}`);
    }
    const covers = (c) => c && startDate >= c.from && endDate <= c.through;
    if (!covers(cov.network)) console.log(`  -> range NOT covered by the network slice: the page falls back to ${srcTz} days ("timezone not applied")`);
    if (cov.inventory && cov.network && (cov.inventory.from !== cov.network.from || cov.inventory.through !== cov.network.through)) {
      console.log('  -> inventory slice covers a different span than the network slice (can make all-sites vs single-site disagree)');
    }
    if (!cov.inventory && !cov.app) { console.log('  no hourly inventory/app data for this network - skipping hourly comparisons'); }

    // 1b. slice health per network day: are all 24 hours stored for every slice, and do the slices agree?
    //     inventory/app hourly use Ad Exchange revenue, the network slice uses Total revenue (GAM rejects HOUR with the
    //     Total columns for inventory dims), so a persistent gap here is a source difference, not a timezone bug.
    const { rows: health } = await db.query(
      `SELECT report_date::text AS d, kind, COUNT(DISTINCT hour)::int AS hrs,
              SUM(revenue)::float8 AS rev, SUM(impressions)::float8 AS imp
       FROM rollup_hourly
       WHERE client_id = $1::uuid AND report_date BETWEEN $2::date AND $3::date AND kind IN ('network', 'inventory', 'app')
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [id, startDate, endDate]
    );
    const byDay = new Map();
    for (const h of health) {
      if (!byDay.has(h.d)) byDay.set(h.d, {});
      byDay.get(h.d)[h.kind] = h;
    }
    console.log('slice health (network-tz days):  day | network hrs $ | inventory hrs $ | app hrs $ | inv vs network');
    for (let d = startDate; d <= endDate; d = shiftYMD(d, 1)) {
      const x = byDay.get(d) || {};
      const cell = (k) => (x[k] ? `${String(x[k].hrs).padStart(2)}h $${fmt(x[k].rev)}` : ' --  --');
      const gap = x.network && x.inventory ? pct(x.inventory.rev, x.network.rev) : 'n/a';
      const holes = ['network', 'inventory', 'app'].filter((k) => !x[k] || x[k].hrs < 24).map((k) => k + (x[k] ? `(${x[k].hrs}h)` : '(none)'));
      console.log(`   ${d} | ${cell('network')} | ${cell('inventory')} | ${cell('app')} | ${gap}${holes.length ? `   <-- incomplete: ${holes.join(', ')}` : ''}`);
    }

    const base = { clientId: id, startDate, endDate, tz, srcTz };
    const baseOwn = { clientId: id, startDate, endDate, tz: srcTz, srcTz };

    // 2. accuracy: hourly in the network's own tz vs normal daily rollups
    const own = await hourlyTotals(baseOwn, scopeAll);
    let normalRev = 0;
    let normalImp = 0;
    try {
      const normal = await runWithClient(client, () => svc.fetchDomainUserRowsFromRollup(startDate, endDate, {
        domains: scopeAll.domains, sites: scopeAll.sites, apps: scopeAll.apps, adUnitNames: scopeAll.adUnitNames, webInventoryOr: scopeAll.webInventoryOr,
      }));
      for (const r of normal?.rows || []) { normalRev += Number(r.revenue) || 0; normalImp += Number(r.impression) || 0; }
      if (normal?.missingDays?.length) console.log(`  (normal rollups are missing days: ${normal.missingDays.join(', ')})`);
    } catch (e) {
      console.log(`  normal rollup read failed: ${e.message}`);
    }
    console.log(`accuracy   hourly@${srcTz}: $${fmt(own.revenue)} / ${Math.round(own.impressions)} imp   normal daily rollups: $${fmt(normalRev)} / ${Math.round(normalImp)} imp   diff ${pct(own.revenue, normalRev)}${flag(own.revenue, normalRev)}`);

    // 3. consistency in the chosen timezone
    const all = await hourlyTotals(base, scopeAll);
    let sumSites = 0;
    const siteRows = [];
    for (const s of sites) {
      const t = await hourlyTotals(base, resolveScopedSqlInventoryOpts(user, { site: s }));
      sumSites += t.revenue;
      if (t.revenue) siteRows.push([s, t.revenue]);
    }
    let sumDomains = 0;
    for (const d of domains) {
      sumDomains += (await hourlyTotals(base, resolveScopedSqlInventoryOpts(user, { domain: d }))).revenue;
    }
    let appRev = 0;
    for (const a of apps) {
      appRev += (await hourlyTotals(base, resolveScopedSqlInventoryOpts(user, { domainId: a }))).revenue;
    }
    console.log(`@${tz}   all assigned: $${fmt(all.revenue)}`);
    console.log(`           sum of ${sites.length} single sites: $${fmt(sumSites)}   sum of ${domains.length} single domains: $${fmt(sumDomains)}   sum of ${apps.length} single apps: $${fmt(appRev)}`);
    console.log(`           sites + apps = $${fmt(sumSites + appRev)} vs all $${fmt(all.revenue)} -> ${pct(sumSites + appRev, all.revenue)}${flag(sumSites + appRev, all.revenue)}`);
    console.log(`           domains + apps = $${fmt(sumDomains + appRev)} vs all $${fmt(all.revenue)} -> ${pct(sumDomains + appRev, all.revenue)}${flag(sumDomains + appRev, all.revenue)}`);
    siteRows.sort((a, b) => b[1] - a[1]);
    if (siteRows.length) console.log(`           top sites: ${siteRows.slice(0, 5).map(([s, r]) => `${s} $${fmt(r)}`).join(' | ')}`);

    grand.all += all.revenue; grand.sumSites += sumSites; grand.sumDomains += sumDomains; grand.apps += appRev;
    grand.normal += normalRev; grand.ownTz += own.revenue;
  }

  console.log('\n=== all networks combined ===');
  console.log(`hourly in each network's own tz $${fmt(grand.ownTz)} vs normal daily $${fmt(grand.normal)}  (${pct(grand.ownTz, grand.normal)})${flag(grand.ownTz, grand.normal)}`);
  console.log(`@${tz}: all assigned $${fmt(grand.all)} | sum single sites + apps $${fmt(grand.sumSites + grand.apps)} | sum single domains + apps $${fmt(grand.sumDomains + grand.apps)}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
