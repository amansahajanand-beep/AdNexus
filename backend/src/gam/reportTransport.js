/**
 * GAM report transport — OAuth token, SOAP, report job poll, CSV download/parse.
 * Shared by HTTP routes and BullMQ sync/report workers (no Express dependency).
 */
const axios = require('axios');
const zlib = require('zlib');
const readline = require('readline');
const logger = require('../utils/logger');
const { GAM_API_VERSION: API_VER } = require('../utils/gamVersion');
const { getClient, getClientId } = require('../utils/clientContext');
const { cache } = require('../gamClient');

// Cache OAuth access token for 55 min (tokens expire after 60 min).
const _tokenCache = new Map();

function NETWORK_CODE() {
  return getClient()?.networkCode || process.env.GAM_NETWORK_CODE;
}

async function getToken() {
  const now = Date.now();
  const cacheId = getClientId() || 'env';
  const hit = _tokenCache.get(cacheId);
  if (hit && now < hit.expiry) {
    logger.info('OAuth token: cache hit');
    return hit.token;
  }
  const t0 = Date.now();
  const { getGAMClient } = require('../gamClient');
  const auth = await getGAMClient();
  const t = await auth.getAccessToken();
  _tokenCache.set(cacheId, { token: t.token, expiry: now + 55 * 60 * 1000 });
  logger.info(`OAuth token: fetched from Google in ${Date.now() - t0}ms`);
  return t.token;
}

function reportEnvelope(method, innerXML) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${API_VER}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${NETWORK_CODE()}</dfp:networkCode>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body><${method} xmlns="https://www.google.com/apis/ads/publisher/${API_VER}">${innerXML}</${method}></soapenv:Body>
</soapenv:Envelope>`;
}

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`));
  return m ? m[1].trim() : null;
}

function buildDateXML(startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-');
  const [ey, em, ed] = endDate.split('-');
  return `<startDate><year>${sy}</year><month>${sm}</month><day>${sd}</day></startDate>
          <endDate><year>${ey}</year><month>${em}</month><day>${ed}</day></endDate>`;
}

async function gamSOAP(service, method, body, token, retries = 2) {
  const url = `https://ads.google.com/apis/ads/publisher/${API_VER}/${service}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, reportEnvelope(method, body), {
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          SOAPAction: '',
          Authorization: `Bearer ${token}`,
        },
        timeout: 300000,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60', 10);
        const wait = Math.min(retryAfter, 120) * 1000;
        logger.warn(`GAM rate limited (429), waiting ${wait / 1000}s before retry ${attempt + 1}/${retries}`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (status === 429) {
        const e = new Error('GAM_RATE_LIMITED');
        e.status = 429;
        throw e;
      }
      const fault = err.response?.data;
      if (fault) {
        const reason = String(fault).match(/<(?:.*:)?errorString>([^<]+)<\/(?:.*:)?errorString>/i)
          || String(fault).match(/<faultstring>([^<]+)<\/faultstring>/i);
        logger.error(`GAM SOAP ${method} fault: ${reason ? reason[1] : String(fault).slice(0, 600)}`);
      }
      throw err;
    }
  }
}

async function pollReport(jobId, token, opts = {}) {
  const fastMode = Boolean(opts.fastMode);
  const firstDelay = Math.max(
    200,
    parseInt(process.env.GAM_REPORT_FIRST_POLL_MS || '400', 10) || 400
  );
  const maxAttempts = fastMode
    ? Math.min(30, parseInt(process.env.GAM_REPORT_MAX_POLLS_FAST || '30', 10) || 30)
    : Math.min(50, parseInt(process.env.GAM_REPORT_MAX_POLLS || '50', 10) || 50);
  const hardDeadline = Date.now() + (fastMode ? 90_000 : 180_000);
  let status = 'IN_PROGRESS';
  let tries = 0;
  while (status === 'IN_PROGRESS' && tries < maxAttempts) {
    if (Date.now() > hardDeadline) {
      throw new Error(`Report poll timed out after ${tries} attempts (job ${jobId})`);
    }
    const delay = tries === 0
      ? firstDelay
      : tries < 3
        ? (fastMode ? 800 : 1000)
        : tries < 10
          ? (fastMode ? 1200 : 2000)
          : (fastMode ? 2000 : 3000);
    await new Promise((r) => setTimeout(r, delay));
    const xml = await gamSOAP('ReportService', 'getReportJobStatus',
      `<reportJobId>${jobId}</reportJobId>`, token);
    status = extractTag(xml, 'rval');
    tries++;
  }
  if (status !== 'COMPLETED') throw new Error(`Report failed: ${status}`);
}

function splitCSVLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field); field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map((v) => v.trim());
}

function parseCSV(csvText) {
  const lines = String(csvText || '').replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    rows.push(rowFromCsvHeaders(headers, line));
  }
  return rows;
}

function rowFromCsvHeaders(headers, line) {
  const vals = splitCSVLine(line);
  const o = Object.create(null);
  for (let i = 0; i < headers.length; i++) o[headers[i]] = vals[i] ?? '';
  return o;
}

/** Stream a gzip CSV: never hold the full text + all row objects at once. */
async function parseGzipCsvStream(inputStream, { onBatch, batchSize = 2000 } = {}) {
  if (typeof onBatch !== 'function') throw new Error('parseGzipCsvStream requires onBatch');
  const gunzip = zlib.createGunzip();
  inputStream.pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  let headers = null;
  let batch = [];
  let total = 0;
  try {
    for await (const rawLine of rl) {
      const line = String(rawLine || '').replace(/\r/g, '');
      if (!line) continue;
      if (!headers) {
        headers = splitCSVLine(line);
        continue;
      }
      batch.push(rowFromCsvHeaders(headers, line));
      if (batch.length >= batchSize) {
        total += batch.length;
        await onBatch(batch);
        batch = [];
      }
    }
    if (batch.length) {
      total += batch.length;
      await onBatch(batch);
    }
  } finally {
    rl.close();
    gunzip.destroy();
  }
  return total;
}

async function runReportAndDownload(reportQueryXML, token, opts = {}) {
  const t0 = Date.now();
  const submitXML = await gamSOAP(
    'ReportService',
    'runReportJob',
    `<reportJob><reportQuery>${reportQueryXML}</reportQuery></reportJob>`,
    token
  );
  const jobId = extractTag(submitXML, 'id');
  if (!jobId) throw new Error('Failed to submit report job');
  logger.info(`GAM job submitted id=${jobId} (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  await pollReport(jobId, token, opts);
  logger.info(`GAM job completed id=${jobId} poll=${Date.now() - t1}ms`);

  const t2 = Date.now();
  const dlXML = await gamSOAP(
    'ReportService',
    'getReportDownloadUrlWithOptions',
    `<reportJobId>${jobId}</reportJobId><reportDownloadOptions><exportFormat>CSV_DUMP</exportFormat><useGzipCompression>true</useGzipCompression></reportDownloadOptions>`,
    token
  );
  let url = extractTag(dlXML, 'rval');
  if (!url) throw new Error('Failed to get report download URL');
  url = decodeEntities(url);

  logger.info(`GAM download URL ready (${Date.now() - t2}ms)`);

  const t3 = Date.now();
  const csvRes = await axios.get(url, { responseType: 'stream', timeout: 300000 });
  const batchSize = Math.max(200, parseInt(process.env.GAM_CSV_BATCH || '2000', 10) || 2000);
  const onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : null;
  const maxInMemory = Math.max(
    1000,
    parseInt(opts.maxRows || process.env.MAX_IN_MEMORY_GAM_ROWS || '400000', 10) || 400000
  );

  let total = 0;
  if (onBatch) {
    total = await parseGzipCsvStream(csvRes.data, { batchSize, onBatch });
    logger.info(`GAM CSV stream-parse ${total} rows in ${Date.now() - t3}ms (total job=${Date.now() - t0}ms)`);
    return { streamed: true, count: total };
  }

  const collected = [];
  total = await parseGzipCsvStream(csvRes.data, {
    batchSize,
    onBatch: async (rows) => {
      if (collected.length + rows.length > maxInMemory) {
        const err = new Error(
          `GAM CSV exceeds in-memory cap (${maxInMemory} rows). Sync path must stream.`
        );
        err.code = 'GAM_CSV_TOO_LARGE';
        throw err;
      }
      for (let i = 0; i < rows.length; i++) collected.push(rows[i]);
    },
  });
  logger.info(`GAM CSV download+parse ${collected.length} rows in ${Date.now() - t3}ms (total job=${Date.now() - t0}ms)`);
  return collected;
}

/** Prevent duplicate in-flight GAM jobs for the same cache key. */
const inflightReports = new Map();
const REPORT_CACHE_TTL = parseInt(process.env.CACHE_TTL, 10) || 3600;

async function fetchWithDedup(cacheKey, fetchFn, ttl = REPORT_CACHE_TTL) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (inflightReports.has(cacheKey)) {
    return inflightReports.get(cacheKey);
  }

  const promise = fetchFn()
    .then((result) => {
      cache.set(cacheKey, result, ttl);
      return result;
    })
    .finally(() => inflightReports.delete(cacheKey));

  inflightReports.set(cacheKey, promise);
  return promise;
}

module.exports = {
  API_VER,
  NETWORK_CODE,
  getToken,
  reportEnvelope,
  decodeEntities,
  extractTag,
  buildDateXML,
  gamSOAP,
  pollReport,
  splitCSVLine,
  parseCSV,
  runReportAndDownload,
  fetchWithDedup,
  REPORT_CACHE_TTL,
  clearTokenCache: () => _tokenCache.clear(),
};
