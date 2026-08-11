const { domainFromAdUnit } = require('./adUnit');

const DEFAULT_LIMIT = 50;
/** Reporting can ask for a larger page; Dashboard still defaults to 50. */
const MAX_LIMIT = 5000;

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Math.max(0, parseInt(parsed.offset, 10) || 0);
  } catch {
    return 0;
  }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset: Math.max(0, offset) }), 'utf8').toString('base64url');
}

function compareSortValues(a, b) {
  const emptyA = a == null || a === '' || a === '—';
  const emptyB = b == null || b === '' || b === '—';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;

  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Resolve a sortable cell value from a report row + column id. */
function getRowSortValue(row, columnId) {
  if (!row || !columnId) return '';
  const id = String(columnId);

  if (id === 'date') return row.date || row.dimensions?.date || '';
  if (id === 'mobile_app_name') return row.appId || row.dimensions?.mobile_app_name || '';
  if (id === 'domain') return row.domainName || domainFromAdUnit(row.site) || row.dimensions?.domain || '';
  if (id === 'site_name') return row.siteName || row.siteUrl || row.dimensions?.site_name || '';
  if (id === 'ad_unit_name') return row.site || row.dimensions?.ad_unit_name || '';
  if (id === 'programmatic_channel_name') return row.channel || row.dimensions?.programmatic_channel_name || '';
  if (id === 'demand_channel_name') return row.demandChannel || row.channel || '';
  if (id === 'country_name' || id === 'country_code') return row.country || row.countryCode || '';

  if (id === 'appId') return row.appId || '';
  if (id === 'domainName') return row.domainName || '';
  if (id === 'siteName') return row.siteName || '';
  if (id === 'impression') return row.impression ?? row.impressions;
  if (id === 'fillRate') return row.fillRate;

  if (row.metrics && row.metrics[id] != null) return row.metrics[id];
  if (id.includes('revenue')) return row.revenue;
  if (id.includes('impressions')) return row.impression ?? row.impressions;
  if (id.includes('ctr')) return row.ctr;
  if (id.includes('ecpm')) return row.ecpm;
  if (id.includes('fill_rate')) return row.fillRate;
  if (id.includes('match_rate')) return row.adxMatchRate;

  return row[id] ?? row.dimensions?.[id] ?? '';
}

function sortRows(rows, sortColumn, sortDir) {
  if (!sortColumn || rows.length < 2) return rows;
  const dir = sortDir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = getRowSortValue(a, sortColumn);
    const bv = getRowSortValue(b, sortColumn);
    return compareSortValues(av, bv) * dir;
  });
}

/**
 * Cursor-based pagination over an in-memory row array.
 * Cursor encodes a byte offset into the sorted list.
 */
function paginateRows(rows = [], { cursor, limit, sortColumn, sortDir } = {}) {
  const safeLimit = Math.min(
    Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT),
    MAX_LIMIT
  );
  const sorted = sortRows(rows, sortColumn, sortDir);
  const totalRows = sorted.length;
  const offset = decodeCursor(cursor);
  const pageRows = sorted.slice(offset, offset + safeLimit);
  const nextOffset = offset + safeLimit;
  const hasMore = nextOffset < totalRows;

  return {
    rows: pageRows,
    pagination: {
      limit: safeLimit,
      offset,
      totalRows,
      hasMore,
      nextCursor: hasMore ? encodeCursor(nextOffset) : null,
      prevCursor: offset > 0 ? encodeCursor(Math.max(0, offset - safeLimit)) : null,
    },
  };
}

function parsePaginationQuery(query = {}) {
  return {
    cursor: query.cursor || null,
    limit: query.limit || DEFAULT_LIMIT,
    sortColumn: query.sortColumn || null,
    sortDir: query.sortDir === 'desc' ? 'desc' : 'asc',
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  compareSortValues,
  getRowSortValue,
  sortRows,
  paginateRows,
  parsePaginationQuery,
};
