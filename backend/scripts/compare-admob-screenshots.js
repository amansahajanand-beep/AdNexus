/**
 * Compare screenshot targets vs DB vs live AdMob API.
 * Image1 yesterday: ~$137 / 36.6K (Messages ~$134.52)
 * Image2 last7 Sep15-21: ~$966 / 258K (Messages ~$954.29)
 */
require('dotenv').config();
const { initSchema, query } = require('../src/db');
const { admobAccountStore } = require('../src/models/publisherAccountStore');
const { getClientById } = require('../src/models/clientStore');
const { runWithClient } = require('../src/utils/clientContext');
const { generateAdMobReport } = require('../src/admob/client');
const { todayInTZ, shiftYMD } = require('../src/utils/datetime');

async function sum(gamClient, account, flavor, start, end, dims = ['DATE']) {
  const rows = await generateAdMobReport(gamClient, {
    accountId: account.accountId,
    refreshToken: account.refreshToken,
    startDate: start,
    endDate: end,
    currencyCode: account.currencyCode || 'USD',
    dimensions: dims,
    flavor,
  });
  return {
    days: rows.length,
    e: rows.reduce((s, r) => s + (Number(r.earnings) || 0), 0),
    i: rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0),
    rows,
  };
}

(async () => {
  await initSchema();
  const id = (await query('SELECT id FROM admob_accounts LIMIT 1')).rows[0].id;
  const account = await admobAccountStore.getAccountById(id);
  const client = await getClientById(account.clientId);
  const today = todayInTZ();
  const yesterday = shiftYMD(today, -1);

  console.log('\n=== Calendar (APP_TIMEZONE) ===');
  console.log({ today, yesterday, last7_incl_today: `${shiftYMD(today, -6)}→${today}`, last7_excl_today: `${shiftYMD(yesterday, -6)}→${yesterday}` });

  console.log('\n=== Screenshot targets ===');
  console.log('Image1 (yesterday): earnings~$137 impressions~36600 Messages~$134.52');
  console.log('Image2 (7d Sep15-21): earnings~$966 impressions~258000 Messages~$954.29');

  const dbDay = async (d) => {
    const r = await query(
      `SELECT earnings::float e, impressions::bigint i FROM admob_report_daily
       WHERE account_id = $1 AND report_date = $2::date`,
      [id, d]
    );
    return r.rows[0] || null;
  };
  const dbRange = async (a, b) => {
    const r = await query(
      `SELECT COALESCE(SUM(earnings),0)::float e, COALESCE(SUM(impressions),0)::bigint i
       FROM admob_report_daily WHERE account_id=$1 AND report_date>=$2::date AND report_date<=$3::date`,
      [id, a, b]
    );
    return r.rows[0];
  };
  const dbApps = async (a, b) => {
    const r = await query(
      `SELECT dim_value, SUM(earnings)::float e, SUM(impressions)::bigint i
       FROM admob_dim_daily
       WHERE account_id=$1 AND dim_kind='app' AND report_date>=$2::date AND report_date<=$3::date
       GROUP BY 1 ORDER BY e DESC LIMIT 5`,
      [id, a, b]
    );
    return r.rows;
  };

  console.log('\n=== DB stored ===');
  for (const d of [yesterday, '2026-09-21', '2026-09-22', today]) {
    console.log(d, await dbDay(d));
  }
  console.log('sep15-21', await dbRange('2026-09-15', '2026-09-21'));
  console.log('last7_excl_today', await dbRange(shiftYMD(yesterday, -6), yesterday));
  console.log('last7_incl_today', await dbRange(shiftYMD(today, -6), today));
  console.log('apps yesterday', await dbApps(yesterday, yesterday));
  console.log('apps sep21', await dbApps('2026-09-21', '2026-09-21'));
  console.log('apps sep15-21', await dbApps('2026-09-15', '2026-09-21'));

  await runWithClient(client, async () => {
    console.log('\n=== Live AdMob API (mediation) ===');
    for (const [label, a, b] of [
      ['yesterday', yesterday, yesterday],
      ['sep21', '2026-09-21', '2026-09-21'],
      ['sep22', '2026-09-22', '2026-09-22'],
      ['sep15-21', '2026-09-15', '2026-09-21'],
      ['last7_excl', shiftYMD(yesterday, -6), yesterday],
    ]) {
      const r = await sum(client, account, 'mediation', a, b);
      console.log(label, { e: +r.e.toFixed(2), i: r.i, days: r.days });
    }

    const appsY = await sum(client, account, 'mediation', yesterday, yesterday, ['DATE', 'APP']);
    const byApp = {};
    for (const r of appsY.rows) {
      const name = r.app || 'Unknown';
      byApp[name] = byApp[name] || { e: 0, i: 0 };
      byApp[name].e += r.earnings;
      byApp[name].i += r.impressions;
    }
    console.log('live apps yesterday', Object.entries(byApp).map(([k, v]) => ({ app: k, e: +v.e.toFixed(2), i: v.i })).sort((a, b) => b.e - a.e));

    const apps21 = await sum(client, account, 'mediation', '2026-09-21', '2026-09-21', ['DATE', 'APP']);
    const byApp21 = {};
    for (const r of apps21.rows) {
      const name = r.app || 'Unknown';
      byApp21[name] = byApp21[name] || { e: 0, i: 0 };
      byApp21[name].e += r.earnings;
      byApp21[name].i += r.impressions;
    }
    console.log('live apps sep21', Object.entries(byApp21).map(([k, v]) => ({ app: k, e: +v.e.toFixed(2), i: v.i })).sort((a, b) => b.e - a.e));
  });

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
