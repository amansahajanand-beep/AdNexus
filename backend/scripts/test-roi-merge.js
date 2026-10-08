/** Adding the ROI of several networks: amounts add, percentages are worked out again from the totals. */
const assert = require('assert');
const { mergeRoiParts } = require('../src/services/roiMerge');

const part = (spend, earn, other, imps, clicks) => ({
  summary: {
    adsSpend: spend, otherExpenses: other, totalCost: spend + other, earn, profitSpend: earn - spend, profitExpense: earn - other,
    profit: earn - spend - other, roiSpendPercent: 0, roiExpensePercent: null, roiPercent: 0, impressions: imps, clicks, conversions: 1,
    ctr: 0, ecpm: 0, mappedSpend: spend, unmappedSpend: 0, mappedCampaigns: 2, accountsWithSpend: 1, adsSpendCurrency: 'INR',
  },
  countryBreakdown: [{ countryCode: 'US', countryName: 'United States', adsSpend: spend, earn, profitSpend: earn - spend, roiSpendPercent: 0, impressions: imps, clicks, conversions: 1, ctr: 0, ecpm: 0 }],
  countryTargetBreakdown: [
    { adsAccountId: 'a1', targetType: 'app', targetKey: 'com.x', countryCode: 'US', countryName: 'United States', adsSpend: spend, earn, otherExpenses: other, profitSpend: earn - spend, profitExpense: earn - other, roiSpendPercent: 0, roiExpensePercent: null, impressions: imps, clicks, conversions: 1, ctr: 0, ecpm: 0 },
    { adsAccountId: 'a2', targetType: 'site', targetKey: `site-${spend}.com`, countryCode: 'US', countryName: 'United States', adsSpend: 0, earn, otherExpenses: 0, profitSpend: earn, profitExpense: earn, roiSpendPercent: null, roiExpensePercent: null, impressions: imps, clicks, conversions: 0, ctr: 0, ecpm: 0, earnOnly: true },
  ],
  countryTargetDailyBreakdown: [],
  rows: [], accounts: [], generalExpenses: [], expenses: [], spendCurrency: 'INR',
});

const a = part(100, 150, 10, 1000, 20);
const b = part(300, 270, 0, 3000, 30);
const m = mergeRoiParts([a, b]);

assert.strictEqual(m.summary.adsSpend, 400);
assert.strictEqual(m.summary.earn, 420);
assert.strictEqual(m.summary.impressions, 4000);
assert.strictEqual(m.summary.roiSpendPercent, 5);          // (420 - 400) / 400, not the average of 50% and -10%
assert.strictEqual(m.summary.roiPercent, +(((420 - 410) / 410) * 100).toFixed(2));
assert.strictEqual(m.summary.ctr, 1.25);                    // 50 clicks / 4000
assert.strictEqual(m.summary.ecpm, 100);                    // spend / impressions x 1000
assert.strictEqual(m.summary.mappedCampaigns, 4);
assert.strictEqual(m.summary.adsSpendCurrency, 'INR');
assert.strictEqual(m.countryBreakdown.length, 1);           // the same country adds up
assert.strictEqual(m.countryBreakdown[0].earn, 420);
assert.strictEqual(m.countryBreakdown[0].roiSpendPercent, 5);
assert.strictEqual(m.countryTargetBreakdown.length, 3);     // same account + app adds up; different sites stay separate
const app = m.countryTargetBreakdown.find((r) => r.targetKey === 'com.x');
assert.strictEqual(app.adsSpend, 400);
assert.strictEqual(app.earn, 420);
const site = m.countryTargetBreakdown.find((r) => r.targetKey === 'site-100.com');
assert.strictEqual(site.roiSpendPercent, null);
assert.strictEqual(site.ecpm, 150);                         // earn-only row: revenue eCPM
assert.strictEqual(a.summary.adsSpend, 100);                // the inputs (cached by the ROI service) are never changed
assert.strictEqual(mergeRoiParts([a]), a);
assert.strictEqual(mergeRoiParts([null, a]), a);
// the same country listed as US (with Ads spend) and as UNITED_STATES (sites only) is one country
const c1 = { countryBreakdown: [{ countryCode: 'US', countryName: 'United States', adsSpend: 10, earn: 5, impressions: 1, clicks: 0, conversions: 0 }],
  countryTargetBreakdown: [{ adsAccountId: 'a1', targetType: 'app', targetKey: 'com.x', countryCode: 'US', countryName: 'United States', adsSpend: 10, earn: 5 }], countryTargetDailyBreakdown: [] };
const c2 = { countryBreakdown: [{ countryCode: 'UNITED_STATES', countryName: 'UNITED_STATES', adsSpend: 0, earn: 7, impressions: 0, clicks: 0, conversions: 0 }],
  countryTargetBreakdown: [{ adsAccountId: 'gam-sites', targetType: 'site', targetKey: 's.com', countryCode: 'UNITED_STATES', countryName: 'UNITED_STATES', adsSpend: 0, earn: 7, earnOnly: true }], countryTargetDailyBreakdown: [] };
const u = mergeRoiParts([c1, c2]);
assert.strictEqual(u.countryBreakdown.length, 1);
assert.strictEqual(u.countryBreakdown[0].countryCode, 'US');
assert.strictEqual(u.countryBreakdown[0].earn, 12);
assert.ok(u.countryTargetBreakdown.every((r) => r.countryCode === 'US'));
console.log('All checks passed');
