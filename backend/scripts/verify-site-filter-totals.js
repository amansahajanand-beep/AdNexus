#!/usr/bin/env node
require('dotenv').config();
const { runWithClient } = require('../src/utils/clientContext');
const { listActiveClients } = require('../src/models/clientStore');

const day = process.argv[2] || '2026-07-25';
const sites = [
  'finance1.finrezo.com', 'finance1.gameplayup.com', 'finance2.gameplayup.com', 'finance9.finrezo.com',
  'game1.novaguildq.com', 'game10.quickplayhub.in', 'game11.quickplayhub.in', 'game12.arenapro6.com',
  'game12.gamebolte.com', 'game13.arenapro6.com', 'game13.playfusionx.in', 'game2.gamebolte.com',
  'game2.gamerforgg.com', 'game2.novaguildq.com', 'game3.gamebolte.com', 'game3.gamerforgg.com',
  'game4.gamebolte.com', 'game4.gamerforgg.com', 'game4.turboquestz.com', 'game5.gamebolte.com',
  'game5.playfusionx.in', 'game5.turboquestz.com', 'game6.nextlevlplay.in', 'game7.nextlevlplay.in',
  'quiz1.novaguildq.com', 'quiz1.turboquestz.com', 'quiz10.quickplayhub.in', 'quiz14.arenapro6.com',
  'quiz2.turboquestz.com', 'quiz3.gamerforgg.com', 'quiz3.gamevoltq.com', 'quiz3.novaguildq.com',
  'quiz3.turboquestz.com', 'quiz4.gamerforgg.com', 'quiz4.gamevoltq.com', 'quiz4.novaguildq.com',
  'quiz5.arenapro6.com', 'quiz5.gamebolte.com', 'quiz5.turboquestz.com', 'quiz7.nextlevlplay.in',
  'quiz7.playfusionx.in', 'quiz8.nextlevlplay.in', 'quiz8.playfusionx.in', 'quiz9.quickplayhub.in',
  'finance7.finrezo.com', 'game6.quickplayhub.in', 'quiz5.arenahubply.com', 'quiz7.quickplayhub.in',
  'game14.gamebolte.com', 'game15.gamebolte.com', 'quiz15.gamebolte.com', 'quiz14.gamebolte.com',
];

(async () => {
  const clients = await listActiveClients();
  await runWithClient(clients[0], async () => {
    const svc = require('../src/services/gamSyncService');
    const bundle = await svc.fetchLeanDashboardBundleFromDB(day, day, {
      sites,
      tableLimit: 2500,
      skipAdUnitLike: true,
    });
    const rowSum = (bundle.rows || []).reduce(
      (a, r) => ({
        rev: a.rev + (Number(r.revenue) || 0),
        imp: a.imp + (Number(r.impression) || 0),
      }),
      { rev: 0, imp: 0 }
    );
    console.log({
      source: bundle.source,
      summaryRev: bundle.summary?.revenue,
      summaryImp: bundle.summary?.impressions,
      rowSumRev: +rowSum.rev.toFixed(2),
      rowSumImp: Math.round(rowSum.imp),
      rows: bundle.rows?.length,
      truncated: bundle.pagination?.truncated,
      top3: (bundle.rows || []).slice(0, 3).map((r) => ({
        site: r.siteUrl,
        revenue: r.revenue,
        impression: r.impression,
      })),
      match: Math.abs((bundle.summary?.revenue || 0) - rowSum.rev) < 0.05,
    });
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
