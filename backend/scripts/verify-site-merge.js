require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { runWithClient } = require('../src/utils/clientContext');
const {
  fetchLeanOverviewTotalsFromDB,
  fetchLeanDashboardBundleFromDB,
} = require('../src/services/gamSyncService');

(async () => {
  await initSchema();
  const clientId = (await query(`SELECT id FROM gam_clients LIMIT 1`)).rows[0]?.id
    || (await query(`SELECT DISTINCT client_id AS id FROM report_grain WHERE client_id IS NOT NULL LIMIT 1`)).rows[0]?.id;

  await runWithClient({ id: clientId }, async () => {
    const day = '2026-08-23';
    const exact = { skipAdUnitLike: true, tableLimit: 500 };

    for (const sites of [
      ['d1.gamisco.com'],
      ['www.gamisco.com'],
      ['quiz13.arenapro6.com'],
      ['d1.gamisco.com', 'quiz13.arenapro6.com'],
      ['game10.quickplayhub.in'],
    ]) {
      const [ov, b] = await Promise.all([
        fetchLeanOverviewTotalsFromDB(day, day, { ...exact, sites }),
        fetchLeanDashboardBundleFromDB(day, day, { ...exact, sites }),
      ]);
      console.log(sites.join('+'), {
        ov: ov && { source: ov.source, rev: ov.revenue, imp: ov.impressions },
        b: b && {
          source: b.source,
          rev: b.summary?.revenue,
          imp: b.summary?.impressions,
          rows: b.rows?.length,
        },
      });
    }
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
