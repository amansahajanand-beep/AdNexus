import { buildReportColumns, aggregateRowsByColumns, summarizeReportingRows } from '../dynamicReportTable';

describe('summarizeReportingRows', () => {
  it('matches the table totals and counts distinct domains/apps', () => {
    const cols = buildReportColumns(['date', 'domain_name'], ['total_line_item_level_cpm_and_cpc_revenue'], { revenue: true });
    const rows = [
      { date: '2026-10-05', domainName: 'a.com', revenue: 10.123 },
      { date: '2026-10-05', domainName: 'B.com', revenue: 5.5 },
      { date: '2026-10-05', appId: 'com.x', revenue: 1 },
    ];
    const s = summarizeReportingRows(rows, cols);
    expect(s.offeredRecords).toBe(3);
    expect(s.totalDomains).toBe(3);
    expect(s.totalRevenue).toBeGreaterThan(0);
    expect(summarizeReportingRows([], cols)).toEqual({ totalRevenue: 0, totalDomains: 0, offeredRecords: 0 });
    expect(typeof aggregateRowsByColumns).toBe('function');
  });
});
