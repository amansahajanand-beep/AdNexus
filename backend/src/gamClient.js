const { google } = require('googleapis');
const NodeCache = require('node-cache');
const logger = require('./utils/logger');
const { getClient, tenantKey } = require('./utils/clientContext');

// NodeCache is L1 only (tiny hot keys in this process). Redis is L2 (shared).
// Never store grain dumps here — that is what OOM'd the API (~3.5GB heap).
const MAX_NODE_CACHE_ARRAY = Math.max(
  100,
  parseInt(process.env.NODE_CACHE_MAX_ARRAY || '3000', 10) || 3000
);

const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL) || 1800,
  maxKeys: parseInt(process.env.NODE_CACHE_MAX_KEYS || '250', 10) || 250,
  useClones: false,
  checkperiod: 120,
});

function nodeCacheValueTooLarge(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > MAX_NODE_CACHE_ARRAY;
  if (Array.isArray(value.rows) && value.rows.length > MAX_NODE_CACHE_ARRAY) return true;
  if (typeof value === 'object' && value.streamed) return true;
  return false;
}

const _rawCacheSet = cache.set.bind(cache);
cache.set = function setCompact(key, value, ttl) {
  if (nodeCacheValueTooLarge(value)) {
    logger.warn(`NodeCache skip ${key}: too large for process memory (use Redis/Postgres)`);
    return false;
  }
  return ttl == null ? _rawCacheSet(key, value) : _rawCacheSet(key, value, ttl);
};

// ─── OAuth2 Client ────────────────────────────────────────────────────────────
function resolveGamCreds(client = getClient()) {
  if (client) {
    return {
      clientId: client.googleClientId,
      clientSecret: client.googleClientSecret,
      redirectUri: client.redirectUri || process.env.GOOGLE_REDIRECT_URI,
      refreshToken: client.refreshToken,
      networkCode: client.networkCode,
    };
  }
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    networkCode: process.env.GAM_NETWORK_CODE,
  };
}

function getOAuthClient(client) {
  const creds = resolveGamCreds(client);
  return new google.auth.OAuth2(
    creds.clientId,
    creds.clientSecret,
    creds.redirectUri
  );
}

// ─── Authenticated DFP/GAM Client ─────────────────────────────────────────────
async function getGAMClient(client) {
  const creds = resolveGamCreds(client);
  const oauth2Client = getOAuthClient(client);
  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken
  });

  oauth2Client.on('tokens', (tokens) => {
    if (!tokens.refresh_token) return;
    const clientId = client?.id || getClient()?.id;
    if (!clientId) {
      logger.info('New Google refresh token received (no client row to persist)');
      return;
    }
    const { updateClientCredentials } = require('./models/clientStore');
    updateClientCredentials(clientId, { refreshToken: tokens.refresh_token })
      .then(() => logger.info(`Persisted rotated Google refresh token for client ${clientId}`))
      .catch((err) => logger.warn('Failed to persist rotated refresh token:', err.message));
  });

  return oauth2Client;
}

// ─── DFP SOAP API via googleapis ─────────────────────────────────────────────
// GAM uses SOAP API. Version is centralized in utils/gamVersion (reads .env).
const { GAM_API_VERSION } = require('./utils/gamVersion');
const GAM_BASE_URL = `https://ads.google.com/apis/ads/publisher/${GAM_API_VERSION}`;
function networkCodeOf(client) {
  return resolveGamCreds(client).networkCode;
}

async function makeGAMRequest(serviceName, methodName, requestBody, client) {
  const cacheKey = tenantKey(`${serviceName}_${methodName}_${JSON.stringify(requestBody)}`);
  const cached = cache.get(cacheKey);
  if (cached) {
    logger.info(`Cache hit: ${cacheKey}`);
    return cached;
  }

  try {
    const auth = await getGAMClient(client);
    const token = await auth.getAccessToken();

    const soap = require('./utils/soapClient');
    const result = await soap.call({
      networkCode: networkCodeOf(client),
      accessToken: token.token,
      apiVersion: GAM_API_VERSION,
      service: serviceName,
      method: methodName,
      body: requestBody
    });

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`GAM API Error [${serviceName}.${methodName}]:`, err.message);
    throw err;
  }
}

// ─── Report Downloader (PQL / Report Service) ────────────────────────────────
async function runReport(reportQuery, client) {
  const cacheKey = tenantKey(`report_${JSON.stringify(reportQuery)}`);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const auth = await getGAMClient(client);
  const tokenObj = await auth.getAccessToken();
  const accessToken = tokenObj.token;

  const axios = require('axios');

  // Step 1: Submit report job
  const submitRes = await axios.post(
    `${GAM_BASE_URL}/ReportService?wsdl`,
    buildReportSOAP('runReportJob', { reportJob: { reportQuery } }),
    {
      headers: {
        'Content-Type': 'text/xml',
        'Authorization': `Bearer ${accessToken}`,
        'clientCustomerId': networkCodeOf(client)
      }
    }
  );

  const reportJobId = parseReportJobId(submitRes.data);

  // Step 2: Poll until done
  let status = 'IN_PROGRESS';
  let attempts = 0;
  while (status !== 'COMPLETED' && attempts < 30) {
    await sleep(2000);
    const statusRes = await axios.post(
      `${GAM_BASE_URL}/ReportService`,
      buildReportSOAP('getReportJobStatus', { reportJobId }),
      {
        headers: {
          'Content-Type': 'text/xml',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    status = parseReportStatus(statusRes.data);
    attempts++;
  }

  // Step 3: Download CSV
  const downloadRes = await axios.get(
    `${GAM_BASE_URL}/ReportService/reportDownload?id=${reportJobId}&exportFormat=CSV_EXCEL`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  const parsed = parseCSV(downloadRes.data);
  cache.set(cacheKey, parsed);
  return parsed;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildReportSOAP(method, params) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${GAM_API_VERSION}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${networkCodeOf(client)}</dfp:networkCode>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <dfp:${method}>${JSON.stringify(params)}</dfp:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function parseReportJobId(xml) {
  const match = xml.match(/<rval>(\d+)<\/rval>/);
  return match ? match[1] : null;
}

function parseReportStatus(xml) {
  const match = xml.match(/<rval>(\w+)<\/rval>/);
  return match ? match[1] : 'FAILED';
}

// Honor quoted fields that may contain commas (e.g. MOBILE_APP_NAME),
// otherwise a naive split(',') misaligns columns and corrupts metrics.
function splitCSVLine(line) {
  const out = [];
  let field = '', inQuotes = false;
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
  return out.map(v => v.trim());
}

function parseCSV(csvData) {
  const lines = csvData.replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCSVLine(line);
    return headers.reduce((obj, h, i) => ({ ...obj, [h]: values[i] ?? '' }), {});
  });
}

module.exports = { getOAuthClient, getGAMClient, makeGAMRequest, runReport, cache, resolveGamCreds, networkCodeOf };
