#!/usr/bin/env node
require('dotenv').config();
const { runWithClient } = require('../src/utils/clientContext');
const { listActiveClients } = require('../src/models/clientStore');
const { normalizeReportRows } = require('../src/utils/rowNormalize');

const day = process.argv[2] || '2026-07-25';
const sites = [
  'quiz9.quickplayhub.in', 'quiz10.quickplayhub.in', 'game2.gamebolte.com',
  'game7.nextlevlplay.in', 'finance1.finrezo.com', 'quiz10.quickplayhub.in',
];

(async () => {
  const clients = await listActiveClients();
  const client = clients[0];
  if (!client) throw new Error('no client');
  await runWithClient(client, async () => {
    // Direct call — not exported, use lean bundle path
    const svc = require('../src/services/gamSyncService');
    const bundle = await svc.fetchLeanDashboardBundleFromDB(day, day, {
      sites,
      tableLimit: 2500,
      skipAdUnitLike: true,
    });
    console.log('source', bundle?.source);
    console.log('summary', {
      revenue: bundle?.summary?.revenue,
      impressions: bundle?.summary?.impressions,
      rows: bundle?.rows?.length,
      truncated: bundle?.pagination?.truncated,
      grainCount: bundle?.grainCount,
    });
    const rawTop = (bundle?.rows || []).slice(0, 8).map((r) => ({
      domain: r.domainName,
      site: r.siteUrl || r.gamSite,
      revenue: r.revenue,
      impression: r.impression,
      revenueDollars: r.revenueDollars,
      ecpm: r.ecpm,
    }));
    console.log('raw top rows', rawTop);
    const normalized = normalizeReportRows(bundle?.rows || []);
    console.log('normalized top', normalized.slice(0, 8).map((r) => ({
      domain: r.domainName,
      site: r.siteUrl || r.gamSite,
      revenue: r.revenue,
      impression: r.impression,
      revenueDollars: r.revenueDollars,
    })));
    const rowSum = normalized.reduce((a, r) => a + (Number(r.revenue) || 0), 0);
    console.log('normalized rowSum', +rowSum.toFixed(2));
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
