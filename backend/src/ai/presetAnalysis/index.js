/**
 * Preset AI analysis.
 *
 *   request -> fact sheet (existing endpoints, in-process, as the user) -> model -> checked result
 *
 * Latency plan: the fact sheet is built from cached, indexed data; the model only receives a few
 * thousand tokens; results are cached by the content of the fact sheet, so identical data never
 * pays for a second model call; and the headline is sent as soon as it has streamed.
 */
const { callRouter } = require('../internalCall');
const { run } = require('../provider');
const { stableKey, getOrCompute, cacheGet, cacheSet } = require('../cache');
const { AiError, CODES } = require('../errors');
const { recentTtlSec } = require('../config');
const { logUsage } = require('../telemetry');
const { parseRequest } = require('./request');
const { finalizeSheet } = require('./common');
const { buildPublisherSheet } = require('./publisher');
const { buildGamSheet } = require('./gam');
const {
  systemPrompt, analysisSchema, userMessage, sanitizeAnalysis, extractStringField,
} = require('./prompt');
const { rulesAnalysis } = require('./rules');

const FEATURE = 'preset-analysis';
const STORED_TTL_SEC = 24 * 3600;
const DATA_TIMEOUT_MS = 20_000;

class AnalysisError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'AnalysisError';
    this.status = status;
    this.code = code;
  }
}

// Required lazily so loading this module does not pull every route in at startup.
const ROUTERS = {
  admob: () => require('../../routes/admob'),
  adsense: () => require('../../routes/adsense'),
  reports: () => require('../../routes/reports'),
  roi: () => require('../../routes/roi'),
};

function makeCall(authorization) {
  return async function call(routerKey, path, query, { required = false, timeoutMs = DATA_TIMEOUT_MS } = {}) {
    let res;
    try {
      res = await callRouter(ROUTERS[routerKey](), { path, query, authorization, timeoutMs });
    } catch (err) {
      if (required) throw new AnalysisError(504, 'The data took too long to load.', 'data_timeout');
      return null;
    }
    if (res.status >= 200 && res.status < 300) return res.body;
    if (required) {
      const status = res.status === 403 ? 403 : 502;
      throw new AnalysisError(status, res.body?.error || 'Could not load the data for this preset.', 'data_unavailable');
    }
    return null;
  };
}

function trimSignal(s) {
  return { severity: s.severity, title: s.title, text: s.text, factIds: s.factIds };
}

/** Facts the screen needs: key figures, signals, and whatever the analysis cites. */
function factsForClient(final, analysis) {
  const ids = new Set(final.metricIds || []);
  for (const s of final.signals) s.factIds.forEach((id) => ids.add(id));
  const take = (list) => (list || []).forEach((x) => (x.factIds || []).forEach((id) => ids.add(id)));
  take(analysis.findings);
  take(analysis.actions);
  take(analysis.deepDive);
  return final.book.pick([...ids]);
}

/**
 * @param {object} opts
 * @param {string} opts.authorization  the caller's Authorization header (forwarded to the data endpoints)
 * @param {{userId: string, clientId?: string}} opts.ctx
 * @param {object} opts.body           { product, kind, startDate, endDate, filters, depth, force }
 * @param {(event: string, data: any) => void} [opts.emit]  progress events: facts, headline, result
 * @param {AbortSignal} [opts.signal]
 */
async function analyzePreset({ authorization, ctx, body, emit = () => {}, signal }) {
  const request = parseRequest(body);
  const deep = request.depth === 'deep';
  const tier = deep ? 'deep' : 'fast';

  const recentKey = stableKey('pa-recent', {
    u: ctx.userId, p: request.product, k: request.kind, s: request.start, e: request.end, f: request.filters, d: request.depth,
  });
  if (!request.force) {
    const recent = await cacheGet(recentKey);
    if (recent) {
      logUsage({ userId: ctx.userId, clientId: ctx.clientId, feature: FEATURE, status: 'cache_hit' });
      emit('facts', recent.early);
      const result = { ...recent.result, meta: { ...recent.result.meta, cached: 'recent' } };
      emit('result', result);
      return result;
    }
  }

  const factsStart = Date.now();
  const build = request.product === 'gam' ? buildGamSheet : buildPublisherSheet;
  const sheet = await build({ request, call: makeCall(authorization), deep });
  const final = finalizeSheet(sheet);
  final.metricIds = sheet.metricIds;
  const factsMs = Date.now() - factsStart;

  const early = {
    facts: final.book.pick([...final.metricIds, ...final.signals.flatMap((s) => s.factIds)]),
    metricIds: final.metricIds,
    signals: final.signals.map(trimSignal),
    noData: final.noData,
    dataSyncedAt: final.syncedAt,
    charts: final.charts,
    currency: final.currency,
  };
  emit('facts', early);

  const validIds = new Set(Object.keys(final.facts));
  let analysis;
  let source = 'ai';
  let aiInfo = {};
  let error = null;
  let cachedFlag = false;

  if (final.noData) {
    analysis = rulesAnalysis(final, { deep });
    source = 'rules';
  } else {
    try {
      const { value, cached } = await getOrCompute({
        key: stableKey('pa-an', { hash: final.hash, tier }),
        ttlSec: STORED_TTL_SEC,
        feature: FEATURE,
        ctx,
        force: request.force,
        compute: async () => {
          let buffer = '';
          let sentHeadline = false;
          const r = await run({
            feature: FEATURE,
            tier,
            system: systemPrompt(deep),
            user: userMessage(final.prompt),
            outputSchema: analysisSchema(deep),
            ctx,
            signal,
            onText: (chunk) => {
              if (sentHeadline) return;
              buffer += chunk;
              const headline = extractStringField(buffer, 'headline');
              if (headline) { sentHeadline = true; emit('headline', { text: headline }); }
            },
          });
          return {
            analysis: sanitizeAnalysis(r.json, validIds, deep),
            model: r.model,
            tier: r.tier,
            generatedAt: new Date().toISOString(),
            aiMs: r.latencyMs,
            firstTokenMs: r.firstTokenMs,
            truncated: r.truncated,
          };
        },
      });
      analysis = value.analysis;
      aiInfo = value;
      cachedFlag = cached ? 'stored' : false;
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      logUsage({ userId: ctx.userId, clientId: ctx.clientId, feature: FEATURE, status: 'fallback', errorCode: err.code });
      analysis = rulesAnalysis(final, { deep });
      source = 'rules';
      error = { code: err.code, message: err.message };
    }
  }

  const result = {
    analysis,
    facts: factsForClient(final, analysis),
    charts: final.charts,
    currency: final.currency,
    meta: {
      source,
      depth: request.depth,
      tier,
      model: aiInfo.model || null,
      cached: cachedFlag,
      generatedAt: aiInfo.generatedAt || new Date().toISOString(),
      dataSyncedAt: final.syncedAt,
      factsMs,
      aiMs: aiInfo.aiMs ?? null,
      firstTokenMs: aiInfo.firstTokenMs ?? null,
      analysisId: final.hash,
      error,
    },
  };
  if (source === 'ai') await cacheSet(recentKey, { early, result }, recentTtlSec());
  emit('result', result);
  return result;
}

/**
 * Build the fact sheet for a request without calling the model (used by alert scans).
 * @returns {Promise<{request: object, final: object}>}
 */
async function buildFacts({ authorization, body }) {
  const request = parseRequest(body);
  const build = request.product === 'gam' ? buildGamSheet : buildPublisherSheet;
  const sheet = await build({ request, call: makeCall(authorization), deep: false });
  const final = finalizeSheet(sheet);
  final.metricIds = sheet.metricIds;
  return { request, final };
}

module.exports = { analyzePreset, buildFacts, AnalysisError };
