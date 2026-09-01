/**
 * Archive report_grain + rollups to S3-compatible object storage (365+ days).
 */
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { query, schemaQuery } = require('../db');
const { historicalRangeForPresets, shiftYMD } = require('../utils/datetime');
const { fetchGrainRowsForArchive } = require('./reportGrainStore');
const logger = require('../utils/logger');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function isArchiveEnabled() {
  return process.env.ARCHIVE_ENABLED === 'true'
    && process.env.S3_BUCKET
    && process.env.S3_ACCESS_KEY_ID
    && process.env.S3_SECRET_ACCESS_KEY;
}

let s3Client = null;

function getS3Client() {
  if (s3Client) return s3Client;
  const config = {
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  };
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
    config.forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== 'false';
  }
  s3Client = new S3Client(config);
  return s3Client;
}

function getArchiveCutoff() {
  return historicalRangeForPresets().startDate;
}

function objectKey(clientId, kind, reportDate) {
  const cid = String(clientId);
  if (kind === 'grain') return `${cid}/grain/${reportDate}.json.gz`;
  if (kind === 'rollup_kpi') return `${cid}/rollups/kpi/${reportDate}.json.gz`;
  if (kind === 'rollup_dim') return `${cid}/rollups/dim/${reportDate}.json.gz`;
  if (kind === 'rollup_network') return `${cid}/rollups/network/${reportDate}.json.gz`;
  throw new Error(`Unknown archive kind: ${kind}`);
}

async function fetchRollupKpiForDate(clientId, reportDate) {
  const { rows } = await schemaQuery(
    `SELECT * FROM rollup_kpi_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  return rows;
}

async function fetchRollupDimForDate(clientId, reportDate) {
  const { rows } = await schemaQuery(
    `SELECT * FROM rollup_dim_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  return rows;
}

async function fetchRollupNetworkForDate(clientId, reportDate) {
  const { rows } = await schemaQuery(
    `SELECT * FROM rollup_network_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  return rows;
}

async function uploadArchive(clientId, kind, reportDate, payload) {
  const json = JSON.stringify(payload);
  const compressed = await gzip(Buffer.from(json, 'utf8'));
  const checksum = crypto.createHash('sha256').update(compressed).digest('hex');
  const key = objectKey(clientId, kind, reportDate);

  await getS3Client().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: compressed,
    ContentType: 'application/gzip',
    ContentEncoding: 'gzip',
  }));

  await schemaQuery(
    `INSERT INTO report_archive_manifest
       (client_id, report_date, archive_kind, object_key, row_count, byte_size, checksum, format)
     VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7, 'json.gz')
     ON CONFLICT (client_id, report_date, archive_kind)
     DO UPDATE SET
       object_key = EXCLUDED.object_key,
       row_count = EXCLUDED.row_count,
       byte_size = EXCLUDED.byte_size,
       checksum = EXCLUDED.checksum,
       archived_at = NOW()`,
    [clientId, reportDate, kind, key, payload.length, compressed.length, checksum]
  );

  return { key, checksum, byteSize: compressed.length, rowCount: payload.length };
}

async function verifyArchive(clientId, reportDate, kind) {
  const { rows } = await schemaQuery(
    `SELECT object_key, checksum FROM report_archive_manifest
     WHERE client_id = $1::uuid AND report_date = $2::date AND archive_kind = $3`,
    [clientId, reportDate, kind]
  );
  if (!rows[0]) return false;
  try {
    const head = await getS3Client().send(new HeadObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: rows[0].object_key,
    }));
    return (head.ContentLength || 0) > 0;
  } catch (e) {
    logger.warn(`verifyArchive failed ${kind} ${reportDate}:`, e.message);
    return false;
  }
}

async function downloadArchive(clientId, reportDate, kind) {
  const { rows } = await schemaQuery(
    `SELECT object_key FROM report_archive_manifest
     WHERE client_id = $1::uuid AND report_date = $2::date AND archive_kind = $3`,
    [clientId, reportDate, kind]
  );
  if (!rows[0]) return null;

  const res = await getS3Client().send(new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: rows[0].object_key,
  }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  const decompressed = await gunzip(buf);
  return JSON.parse(decompressed.toString('utf8'));
}

async function exportDayToArchive(clientId, reportDate) {
  if (!isArchiveEnabled()) {
    logger.info(`Archive disabled — skip ${reportDate}`);
    return false;
  }

  const grain = await fetchGrainRowsForArchive(clientId, reportDate);
  const kpi = await fetchRollupKpiForDate(clientId, reportDate);
  const dim = await fetchRollupDimForDate(clientId, reportDate);
  const network = await fetchRollupNetworkForDate(clientId, reportDate);

  if (!grain.length && !kpi.length && !dim.length && !network.length) {
    logger.info(`Archive skip ${reportDate} — no rows`);
    return false;
  }

  if (grain.length) await uploadArchive(clientId, 'grain', reportDate, grain);
  if (kpi.length) await uploadArchive(clientId, 'rollup_kpi', reportDate, kpi);
  if (dim.length) await uploadArchive(clientId, 'rollup_dim', reportDate, dim);
  if (network.length) await uploadArchive(clientId, 'rollup_network', reportDate, network);

  const kinds = [];
  if (grain.length) kinds.push('grain');
  if (kpi.length) kinds.push('rollup_kpi');
  if (dim.length) kinds.push('rollup_dim');
  if (network.length) kinds.push('rollup_network');

  for (const kind of kinds) {
    const ok = await verifyArchive(clientId, reportDate, kind);
    if (!ok) throw new Error(`Archive verify failed: ${kind} ${reportDate}`);
  }
  return true;
}

async function purgeDayFromPostgres(clientId, reportDate) {
  await schemaQuery(
    `DELETE FROM report_grain WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  await schemaQuery(
    `DELETE FROM rollup_kpi_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  await schemaQuery(
    `DELETE FROM rollup_dim_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  await schemaQuery(
    `DELETE FROM rollup_network_daily WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
}

async function listDatesToArchive(clientId) {
  const cutoff = getArchiveCutoff();
  const { rows } = await schemaQuery(
    `SELECT DISTINCT to_char(g.report_date, 'YYYY-MM-DD') AS report_date
     FROM report_grain g
     WHERE g.client_id = $1::uuid AND g.report_date < $2::date
       AND NOT EXISTS (
         SELECT 1 FROM report_archive_manifest m
         WHERE m.client_id = g.client_id
           AND m.report_date = g.report_date
           AND m.archive_kind = 'grain'
       )
     ORDER BY 1`,
    [clientId, cutoff]
  );
  return rows.map((r) => r.report_date);
}

async function archiveColdDaysForClient(clientId) {
  if (!isArchiveEnabled()) return 0;
  const dates = await listDatesToArchive(clientId);
  let archived = 0;
  for (const day of dates) {
    try {
      const ok = await exportDayToArchive(clientId, day);
      if (ok) {
        await purgeDayFromPostgres(clientId, day);
        archived += 1;
        logger.info(`Archived + purged ${day} for client ${String(clientId).slice(0, 8)}`);
      }
    } catch (e) {
      logger.error(`Archive failed ${day} client ${String(clientId).slice(0, 8)}:`, e.message);
    }
  }
  return archived;
}

async function isDayFullyArchived(clientId, reportDate) {
  const { rows } = await schemaQuery(
    `SELECT archive_kind FROM report_archive_manifest
     WHERE client_id = $1::uuid AND report_date = $2::date`,
    [clientId, reportDate]
  );
  const kinds = new Set(rows.map((r) => r.archive_kind));
  return kinds.has('grain') || (kinds.has('rollup_kpi') && kinds.has('rollup_dim'));
}

async function listArchivedDates(clientId, startDate, endDate) {
  const { rows } = await schemaQuery(
    `SELECT DISTINCT to_char(report_date, 'YYYY-MM-DD') AS report_date
     FROM report_archive_manifest
     WHERE client_id = $1::uuid
       AND report_date BETWEEN $2::date AND $3::date
       AND archive_kind = 'grain'
     ORDER BY 1`,
    [clientId, startDate, endDate]
  );
  return rows.map((r) => r.report_date);
}

function splitDateRange(startDate, endDate) {
  const cutoff = getArchiveCutoff();
  const coldEnd = shiftYMD(cutoff, -1);
  let hotStart = startDate;
  let hotEnd = endDate;
  let coldStart = null;
  let coldEndDate = null;

  if (endDate < cutoff) {
    hotStart = null;
    hotEnd = null;
    coldStart = startDate;
    coldEndDate = endDate;
  } else if (startDate >= cutoff) {
    coldStart = null;
    coldEndDate = null;
  } else {
    coldStart = startDate;
    coldEndDate = coldEnd < endDate ? coldEnd : endDate;
    hotStart = cutoff;
    hotEnd = endDate;
  }

  return { hotStart, hotEnd, coldStart, coldEnd: coldEndDate, cutoff };
}

async function fetchArchivedGrain(clientId, startDate, endDate) {
  if (!isArchiveEnabled()) return [];
  const dates = await listArchivedDates(clientId, startDate, endDate);
  const all = [];
  for (const day of dates) {
    try {
      const rows = await downloadArchive(clientId, day, 'grain');
      if (Array.isArray(rows)) all.push(...rows);
    } catch (e) {
      logger.warn(`fetchArchivedGrain ${day}:`, e.message);
    }
  }
  return all;
}

async function fetchArchivedRollupKpi(clientId, startDate, endDate) {
  if (!isArchiveEnabled()) return [];
  const { rows } = await schemaQuery(
    `SELECT report_date FROM report_archive_manifest
     WHERE client_id = $1::uuid AND report_date BETWEEN $2::date AND $3::date
       AND archive_kind = 'rollup_kpi'`,
    [clientId, startDate, endDate]
  );
  const all = [];
  for (const r of rows) {
    const day = String(r.report_date).slice(0, 10);
    try {
      const data = await downloadArchive(clientId, day, 'rollup_kpi');
      if (Array.isArray(data)) all.push(...data);
    } catch (e) {
      logger.warn(`fetchArchivedRollupKpi ${day}:`, e.message);
    }
  }
  return all;
}

async function fetchArchivedNetworkRollup(clientId, startDate, endDate) {
  if (!isArchiveEnabled()) return [];
  const { rows } = await schemaQuery(
    `SELECT report_date FROM report_archive_manifest
     WHERE client_id = $1::uuid AND report_date BETWEEN $2::date AND $3::date
       AND archive_kind = 'rollup_network'`,
    [clientId, startDate, endDate]
  );
  const all = [];
  for (const r of rows) {
    const day = String(r.report_date).slice(0, 10);
    try {
      const data = await downloadArchive(clientId, day, 'rollup_network');
      if (Array.isArray(data)) all.push(...data);
    } catch (e) {
      logger.warn(`fetchArchivedNetworkRollup ${day}:`, e.message);
    }
  }
  return all;
}

async function fetchArchivedRollupDim(clientId, startDate, endDate) {
  if (!isArchiveEnabled()) return [];
  const { rows } = await schemaQuery(
    `SELECT report_date FROM report_archive_manifest
     WHERE client_id = $1::uuid AND report_date BETWEEN $2::date AND $3::date
       AND archive_kind = 'rollup_dim'`,
    [clientId, startDate, endDate]
  );
  const all = [];
  for (const r of rows) {
    const day = String(r.report_date).slice(0, 10);
    try {
      const data = await downloadArchive(clientId, day, 'rollup_dim');
      if (Array.isArray(data)) all.push(...data);
    } catch (e) {
      logger.warn(`fetchArchivedRollupDim ${day}:`, e.message);
    }
  }
  return all;
}

function archivedGrainToLegacy(row) {
  const { grainRowToLegacyDimensions, grainRowToLegacyMetrics } = require('./dimLookupService');
  const dimensions = grainRowToLegacyDimensions(row, {
    country: row.country_name,
    device: row.device_name,
    adUnit: row.ad_unit_name,
    domain: row.domain_name,
    site: row.site_name,
  });
  const metrics = grainRowToLegacyMetrics(row);
  return {
    report_date: row.report_date,
    dimensions,
    metrics,
    currency: row.currency || 'USD',
    synced_at: row.synced_at,
    source: 'archive',
  };
}

module.exports = {
  isArchiveEnabled,
  getArchiveCutoff,
  splitDateRange,
  exportDayToArchive,
  purgeDayFromPostgres,
  archiveColdDaysForClient,
  isDayFullyArchived,
  listArchivedDates,
  fetchArchivedGrain,
  fetchArchivedRollupKpi,
  fetchArchivedRollupDim,
  fetchArchivedNetworkRollup,
  archivedGrainToLegacy,
  downloadArchive,
};
