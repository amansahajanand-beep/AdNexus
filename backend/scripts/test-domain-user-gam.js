/**
 * Quick GAM check: today's report with domain-user dimension sets vs URL_NAME set.
 */
require('dotenv').config();
const { todayInTZ } = require('../src/utils/datetime');

const DOMAIN_USER_DIMENSION_SETS = [
  ['DATE', 'MOBILE_APP_NAME', 'DOMAIN', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'MOBILE_APP_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'],
  ['DATE', 'AD_UNIT_NAME'],
];

const BAD_SET = ['DATE', 'MOBILE_APP_NAME', 'URL_NAME', 'SITE_NAME', 'AD_UNIT_NAME', 'AD_UNIT_ID'];

const DEFAULT_DETAIL_METRICS = [
  'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',
  'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
  'TOTAL_LINE_ITEM_LEVEL_CLICKS',
  'TOTAL_LINE_ITEM_LEVEL_CTR',
  'TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS',
];

function rawRowsHaveMetrics(raw = []) {
  if (!raw?.length) return false;
  let imp = 0;
  let rev = 0;
  for (const r of raw) {
    imp += parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0, 10);
    rev += parseFloat(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE'] || 0);
  }
  return imp > 0 || rev > 0;
}

function summarizeRaw(raw, label) {
  let imp = 0;
  let revMicros = 0;
  for (const r of raw) {
    imp += parseInt(r['Column.TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'] || 0, 10);
    revMicros += parseFloat(r['Column.TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE'] || 0);
  }
  const rev = +(revMicros / 1e6).toFixed(2);
  console.log(`\n[${label}] rows=${raw.length} impressions=${imp} revenue=$${rev} hasMetrics=${rawRowsHaveMetrics(raw)}`);
  if (raw[0]) {
    const keys = Object.keys(raw[0]).filter((k) => k.startsWith('Column.'));
    console.log('  sample columns:', keys.slice(0, 5).join(', '));
  }
}

async function main() {
  const reports = require('../src/routes/reports');
  const { getToken, runReportAndDownload } = reports.__gamHelpers;

  const today = todayInTZ();
  console.log('Testing GAM for date:', today);

  const token = await getToken();
  const sd = today.split('-');
  const ed = today.split('-');
  const countryFilter = '';

  const buildQuery = (dimensions) => {
    const dimXML = dimensions.map((d) => `<dimensions>${d}</dimensions>`).join('\n    ');
    const colXML = DEFAULT_DETAIL_METRICS.map((c) => `<columns>${c}</columns>`).join('\n    ');
    return `
    ${dimXML}
    <adUnitView>FLAT</adUnitView>
    ${colXML}
    <startDate><year>${sd[0]}</year><month>${+sd[1]}</month><day>${+sd[2]}</day></startDate>
    <endDate><year>${ed[0]}</year><month>${+ed[1]}</month><day>${+ed[2]}</day></endDate>
    <dateRangeType>CUSTOM_DATE</dateRangeType>${countryFilter}`;
  };

  for (const dims of DOMAIN_USER_DIMENSION_SETS) {
    try {
      const raw = await runReportAndDownload(buildQuery(dims), token);
      summarizeRaw(raw, dims.join(', '));
    } catch (e) {
      console.log(`\n[${dims.join(', ')}] FAILED:`, e.message);
    }
  }

  try {
    const raw = await runReportAndDownload(buildQuery(BAD_SET), token);
    summarizeRaw(raw, 'URL_NAME set (bad)');
  } catch (e) {
    console.log('\n[URL_NAME set] FAILED:', e.message);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
