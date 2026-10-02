/**
 * Usage and feedback logging. Usage rows are buffered and written in batches so a model
 * call never waits on a database write.
 */
const { query } = require('../db');
const logger = require('../utils/logger');

const FLUSH_MS = 2000;
const FLUSH_AT = 50;
const MAX_BUFFER = 2000;

let buffer = [];
let timer = null;

async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length) return;
  const rows = buffer;
  buffer = [];
  const cols = [
    'user_id', 'client_id', 'feature', 'tier', 'model', 'status', 'input_tokens', 'output_tokens',
    'cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'first_token_ms', 'est_cost_usd', 'error_code',
  ];
  const params = [];
  const tuples = rows.map((r) => {
    const base = params.length;
    params.push(
      r.userId ?? null, r.clientId ?? null, r.feature, r.tier ?? null, r.model ?? null, r.status,
      r.inputTokens || 0, r.outputTokens || 0, r.cacheReadTokens || 0, r.cacheWriteTokens || 0,
      r.latencyMs ?? null, r.firstTokenMs ?? null, r.estCostUsd ?? null, r.errorCode ?? null
    );
    return `(${cols.map((_, i) => `$${base + i + 1}`).join(', ')})`;
  });
  try {
    await query(`INSERT INTO ai_usage_log (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  } catch (err) {
    logger.warn(`ai usage log write failed (${rows.length} rows dropped): ${err.message}`);
  }
}

/** status: ok | error | rate_limited | budget | cache_hit | fallback */
function logUsage(row) {
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push(row);
  logger.info(
    `ai ${row.feature} ${row.status}${row.tier ? ` tier=${row.tier}` : ''}`
    + `${row.latencyMs != null ? ` ${row.latencyMs}ms` : ''}`
    + `${row.inputTokens || row.outputTokens ? ` tok=${row.inputTokens || 0}/${row.outputTokens || 0}` : ''}`
    + `${row.cacheReadTokens ? ` cached=${row.cacheReadTokens}` : ''}`
    + `${row.errorCode ? ` err=${row.errorCode}` : ''}`
  );
  if (buffer.length >= FLUSH_AT) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS).unref();
}

async function addFeedback({ userId, clientId, feature, targetKey, rating, comment }) {
  await query(
    `INSERT INTO ai_feedback (user_id, client_id, feature, target_key, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [String(userId), clientId ? String(clientId) : null, feature, targetKey || null, rating, comment || null]
  );
}

/** Admin summary: totals, cache hit rate and latency percentiles per feature. */
async function usageSummary(clientId, days = 7) {
  const d = Math.min(90, Math.max(1, parseInt(days, 10) || 7));
  const params = [d];
  let scope = '';
  if (clientId) { params.push(String(clientId)); scope = ' AND client_id = $2'; }
  const { rows } = await query(
    `SELECT feature,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE status = 'ok')::int AS ok,
            COUNT(*) FILTER (WHERE status = 'cache_hit')::int AS cache_hits,
            COUNT(*) FILTER (WHERE status IN ('error', 'fallback'))::int AS failures,
            COUNT(*) FILTER (WHERE status IN ('rate_limited', 'budget'))::int AS limited,
            COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(est_cost_usd), 0)::float8 AS est_cost_usd,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok') AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok') AS p95_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE status = 'ok') AS first_token_p50_ms
     FROM ai_usage_log
     WHERE created_at >= now() - ($1 || ' days')::interval ${scope}
     GROUP BY feature
     ORDER BY calls DESC`,
    params
  );
  const fb = await query(
    `SELECT feature, COUNT(*) FILTER (WHERE rating = 1)::int AS up, COUNT(*) FILTER (WHERE rating = -1)::int AS down
     FROM ai_feedback
     WHERE created_at >= now() - ($1 || ' days')::interval ${scope}
     GROUP BY feature`,
    params
  );
  const fbBy = new Map(fb.rows.map((r) => [r.feature, r]));
  return rows.map((r) => ({
    ...r,
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    p50_ms: r.p50_ms == null ? null : Math.round(r.p50_ms),
    p95_ms: r.p95_ms == null ? null : Math.round(r.p95_ms),
    first_token_p50_ms: r.first_token_p50_ms == null ? null : Math.round(r.first_token_p50_ms),
    cache_hit_rate: r.calls ? Math.round((r.cache_hits / r.calls) * 1000) / 10 : 0,
    feedback_up: fbBy.get(r.feature)?.up || 0,
    feedback_down: fbBy.get(r.feature)?.down || 0,
  }));
}

process.once('beforeExit', () => { flush(); });

/** One row per day for the last `days` days, including days with no activity. */
async function dailySeries(clientId, days = 14) {
  const d = Math.min(60, Math.max(2, parseInt(days, 10) || 14));
  const params = [d];
  let scope = '';
  if (clientId) { params.push(String(clientId)); scope = ' AND client_id = $2'; }
  const { rows } = await query(
    `SELECT g.day::date::text AS day,
            COALESCE(u.calls, 0)::int AS calls,
            COALESCE(u.failures, 0)::int AS failures,
            COALESCE(u.tokens, 0)::bigint AS tokens
     FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') AS g(day)
     LEFT JOIN (
       SELECT created_at::date AS day,
              COUNT(*) FILTER (WHERE status <> 'cache_hit') AS calls,
              COUNT(*) FILTER (WHERE status IN ('error', 'fallback')) AS failures,
              SUM(input_tokens + output_tokens) AS tokens
       FROM ai_usage_log
       WHERE created_at >= current_date - ($1::int - 1) ${scope}
       GROUP BY 1
     ) u ON u.day = g.day::date
     ORDER BY g.day`,
    params
  );
  return rows.map((r) => ({ day: r.day, calls: r.calls, failures: r.failures, tokens: Number(r.tokens) }));
}

const SERIES = {
  day: { unit: 'day', span: 30, step: '1 day', label: 'YYYY-MM-DD' },
  month: { unit: 'month', span: 12, step: '1 month', label: 'YYYY-MM' },
  year: { unit: 'year', span: 5, step: '1 year', label: 'YYYY' },
};

/**
 * Tokens used per day (last 30), month (last 12) or year (last 5), empty periods included.
 * Only requests that reached the model count; results served from saved answers use no tokens.
 */
async function tokenSeries(clientId, by = 'day') {
  const s = SERIES[by] || SERIES.day;
  const params = [];
  let scope = '';
  if (clientId) { params.push(String(clientId)); scope = ' AND client_id = $1'; }
  const first = `date_trunc('${s.unit}', current_date) - interval '${s.span - 1} ${s.unit}'`;
  const { rows } = await query(
    `SELECT to_char(g.p, '${s.label}') AS period,
            COALESCE(u.input, 0)::bigint AS input,
            COALESCE(u.output, 0)::bigint AS output,
            COALESCE(u.requests, 0)::int AS requests
     FROM generate_series(${first}, date_trunc('${s.unit}', current_date), interval '${s.step}') AS g(p)
     LEFT JOIN (
       SELECT date_trunc('${s.unit}', created_at) AS p,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS requests
       FROM ai_usage_log
       WHERE created_at >= ${first} AND input_tokens + output_tokens > 0 ${scope}
       GROUP BY 1
     ) u ON u.p = g.p
     ORDER BY g.p`,
    params
  );
  return rows.map((r) => ({
    period: r.period, input: Number(r.input), output: Number(r.output), tokens: Number(r.input) + Number(r.output), requests: r.requests,
  }));
}

/** Average tokens per model request for each feature over the last `days` days. */
async function tokenAverages(clientId, days = 90) {
  const d = Math.min(365, Math.max(1, parseInt(days, 10) || 90));
  const params = [d];
  let scope = '';
  if (clientId) { params.push(String(clientId)); scope = ' AND client_id = $2'; }
  const { rows } = await query(
    `SELECT feature, COUNT(*)::int AS requests,
            COALESCE(SUM(input_tokens), 0)::bigint AS input, COALESCE(SUM(output_tokens), 0)::bigint AS output
     FROM ai_usage_log
     WHERE created_at >= now() - ($1 || ' days')::interval AND input_tokens + output_tokens > 0 ${scope}
     GROUP BY feature`,
    params
  );
  return rows.map((r) => {
    const n = r.requests || 1;
    return {
      feature: r.feature,
      requests: r.requests,
      avgInput: Math.round(Number(r.input) / n),
      avgOutput: Math.round(Number(r.output) / n),
      avgTotal: Math.round((Number(r.input) + Number(r.output)) / n),
    };
  });
}

async function recentFeedback(clientId, limit = 12) {
  const params = [Math.min(50, Math.max(1, parseInt(limit, 10) || 12))];
  let scope = '';
  if (clientId) { params.push(String(clientId)); scope = ' WHERE client_id = $2'; }
  const { rows } = await query(
    `SELECT feature, rating, comment, created_at FROM ai_feedback ${scope} ORDER BY created_at DESC LIMIT $1`,
    params
  );
  return rows.map((r) => ({ feature: r.feature, rating: r.rating, comment: r.comment, createdAt: r.created_at }));
}

async function recentFailures(clientId, limit = 8) {
  const params = [Math.min(50, Math.max(1, parseInt(limit, 10) || 8))];
  let scope = '';
  if (clientId) { params.push(String(clientId)); scope = ' AND client_id = $2'; }
  const { rows } = await query(
    `SELECT feature, status, error_code, created_at FROM ai_usage_log
     WHERE status IN ('error', 'fallback', 'rate_limited', 'budget') ${scope}
     ORDER BY created_at DESC LIMIT $1`,
    params
  );
  return rows.map((r) => ({ feature: r.feature, status: r.status, code: r.error_code, createdAt: r.created_at }));
}

module.exports = {
  logUsage, addFeedback, usageSummary, dailySeries, tokenSeries, tokenAverages, recentFeedback, recentFailures, flush,
};
