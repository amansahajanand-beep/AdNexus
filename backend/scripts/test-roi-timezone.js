/**
 * ROI earnings follow the viewing timezone: a site's earnings over a local day, per site and per day, equal an
 * independent regroup of the stored hours, and the network's own zone equals the daily warehouse figure.
 *
 *   node scripts/test-roi-timezone.js
 */
process.env.REDIS_DISABLED = process.env.REDIS_DISABLED || 'true';

const assert = require('assert');
const db = require('../src/db');
const roi = require('../src/services/roiService');
const hv = require('../src/services/hourlyView');
const { getNetworkTz } = require('../src/services/networkTimezone');
const { getClientById } = require('../src/models/clientStore');
const { shiftYMD, ymdInTZ } = require('../src/utils/datetime');

const E = roi._earn;
const near = (a, b, msg, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

(async () => {
  const { rows } = await db.schemaQuery(`SELECT client_id FROM rollup_hourly WHERE kind = 'inventory' GROUP BY client_id ORDER BY COUNT(*) DESC LIMIT 1`);
  if (!rows[0]) { console.log('skipped: no hourly data'); process.exit(0); }
  const clientId = rows[0].client_id;
  const srcTz = await getNetworkTz(await getClientById(clientId));
  const cov = await hv.coverage(clientId, srcTz, ymdInTZ(new Date(), srcTz), srcTz, Date.now(), 'inventory');
  if (!cov) { console.log('skipped: hourly data is stale'); process.exit(0); }
  const day = shiftYMD(cov.through, -3);
  const { rows: top } = await db.schemaQuery(
    `SELECT LOWER(dim_b) AS site FROM rollup_hourly
     WHERE client_id = $1::uuid AND kind = 'inventory' AND report_date = $2::date AND dim_b ~ '^[a-z0-9][a-z0-9.-]+[.][a-z]{2,}$'
     GROUP BY 1 ORDER BY SUM(revenue) DESC LIMIT 1`,
    [clientId, day]
  );
  const site = top[0]?.site;
  assert.ok(site, 'a site with earnings');

  const failures = [];
  for (const tz of ['America/New_York', 'Asia/Kolkata', 'Pacific/Honolulu', 'Asia/Tokyo']) {
    if (tz === srcTz) continue;
    try {
      const zone = { clientId, tz, srcTz };
      const independent = (await hv.hourlyTrend({
        clientId, startDate: day, endDate: day, tz, srcTz, kind: 'inventory', filter: { sites: [site] },
      })).reduce((a, d) => a + d.earning, 0);

      const agg = await E.zoneStore.run(zone, () => E.loadGamEarnByTargetAggregatedScoped(clientId, day, day, { siteKeys: [site], appKeys: [] }));
      near(agg.sites.find((r) => r.targetKey === site)?.earn || 0, independent, `${tz}: aggregated site earn`);

      const daily = await E.zoneStore.run(zone, () => E.loadGamEarnByTargetDaily(clientId, day, day));
      near(daily.sites.find((r) => r.targetKey === site)?.earn || 0, independent, `${tz}: daily site earn`);

      const linked = await E.zoneStore.run(zone, () => E.loadAdsLinkedGamEarn(clientId, day, day, {}));
      assert.ok(Number.isFinite(linked), `${tz}: linked earn is a number`);

      const network = (await hv.hourlyTrend({ clientId, startDate: day, endDate: day, tz, srcTz, kind: 'network' })).reduce((a, d) => a + d.earning, 0);
      near(await E.zoneStore.run(zone, () => E.loadCanonicalGamEarn(clientId, day, day)), network, `${tz}: network earn`);
      console.log(`ok   ${tz}: ${site} on ${day} = ${independent.toFixed(2)}`);
    } catch (err) {
      failures.push(err.message);
      console.log(`FAIL ${err.message}`);
    }
  }

  // The network's own zone regroups to exactly what the daily warehouse holds.
  const zone = { clientId, tz: srcTz, srcTz };
  const own = await E.zoneStore.run(zone, () => E.loadGamEarnByTargetAggregatedScoped(clientId, day, day, { siteKeys: [site], appKeys: [] }));
  const grain = await E.loadGamEarnByTargetAggregatedScoped(clientId, day, day, { siteKeys: [site], appKeys: [] });
  if (grain.sites[0]?.earn > 0) {
    near(own.sites[0]?.earn || 0, grain.sites[0].earn, 'network zone equals the daily warehouse', 1);
    console.log('ok   network zone matches the daily figure');
  } else {
    // The daily warehouse is missing some days (the hourly data is the complete one), so there is nothing to compare.
    console.log(`note ${day} has no daily warehouse row for ${site}; network-zone comparison skipped`);
  }

  // No zone chosen: nothing changes.
  assert.strictEqual(typeof (await E.loadCanonicalGamEarn(clientId, day, day)), 'number');

  if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
  console.log('All checks passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
