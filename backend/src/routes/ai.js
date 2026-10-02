const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const ai = require('../ai');
const {
  tiers, providerInfo, globalEnabled, hasCredentials, limits,
} = require('../ai/config');
const logger = require('../utils/logger');
const { analyzePreset } = require('../ai/presetAnalysis');
const { RequestError } = require('../ai/presetAnalysis/request');
const { suggestMappings } = require('../ai/mapping');
const alerts = require('../ai/alerts');
const { askData } = require('../ai/ask');
const reports = require('../ai/report');
const { explainChange, ExplainError } = require('../ai/explain');
const { accountIdFor } = require('../ai/accounts');

const router = express.Router();

/** Whether AI is on for this user, and how much of today's allowance is left. The UI hides AI when `enabled` is false. */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const access = await ai.resolveAiAccess(req.user);
    const usage = access.enabled ? await ai.usageToday(req.user.id, req.user.clientId) : null;
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: access.enabled, reason: access.reason, usage });
  } catch (err) {
    logger.error('ai status:', err.message);
    res.status(500).json({ error: 'Could not read AI status' });
  }
});

/** Admin: turn AI on or off for this account (all of its networks). */
router.put('/settings', requireAdmin, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  if (!req.user.clientId) return res.status(400).json({ error: 'No account to update' });
  try {
    await ai.setAccountAiEnabled(req.user.clientId, req.body.enabled);
    const access = await ai.resolveAiAccess(req.user);
    res.json({ enabled: access.enabled, reason: access.reason });
  } catch (err) {
    logger.error('ai settings:', err.message);
    res.status(500).json({ error: 'Could not save AI setting' });
  }
});

/** Thumbs up/down on an AI result. */
router.post('/feedback', requireAuth, async (req, res) => {
  const { feature, targetKey, rating, comment } = req.body || {};
  const value = rating === 'up' ? 1 : rating === 'down' ? -1 : null;
  if (!feature || typeof feature !== 'string' || feature.length > 60 || value == null) {
    return res.status(400).json({ error: 'feature and rating (up or down) are required' });
  }
  try {
    await ai.addFeedback({
      userId: req.user.id,
      clientId: req.user.clientId,
      feature,
      targetKey: typeof targetKey === 'string' ? targetKey.slice(0, 200) : null,
      rating: value,
      comment: typeof comment === 'string' ? comment.trim().slice(0, 500) : null,
    });
    return res.json({ ok: true });
  } catch (err) {
    logger.error('ai feedback:', err.message);
    return res.status(500).json({ error: 'Could not save feedback' });
  }
});

/** Admin: calls, cache hit rate, latency, tokens, cost and feedback per feature. */
router.get('/usage', requireAdmin, async (req, res) => {
  try {
    const rows = await ai.usageSummary(req.user.clientId, req.query.days);
    res.set('Cache-Control', 'no-store');
    res.json({ days: Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7)), features: rows });
  } catch (err) {
    logger.error('ai usage:', err.message);
    res.status(500).json({ error: 'Could not load AI usage' });
  }
});

/** Admin: tokens used per day, month or year for the usage chart. */
router.get('/token-series', requireAdmin, async (req, res) => {
  try {
    const by = ['day', 'month', 'year'].includes(req.query.by) ? req.query.by : 'day';
    await ai.flushUsage();
    const rows = await ai.tokenSeries(req.user.clientId || null, by);
    res.set('Cache-Control', 'no-store');
    res.json({ by, rows });
  } catch (err) {
    logger.error('ai token series:', err.message);
    res.status(500).json({ error: 'Could not load token usage' });
  }
});

/** Admin: everything the AI settings page shows, in one call. */
router.get('/admin', requireAdmin, async (req, res) => {
  try {
    const clientId = req.user.clientId || null;
    const access = await ai.resolveAiAccess(req.user);
    await ai.flushUsage();
    const [setting, features, daily, averages, tokenDays, feedback, failures, usageToday] = await Promise.all([
      ai.getAccountSetting(clientId),
      ai.usageSummary(clientId, 7),
      ai.dailySeries(clientId, 14),
      ai.tokenAverages(clientId, 90),
      ai.tokenSeries(clientId, 'day'),
      ai.recentFeedback(clientId, 12),
      ai.recentFailures(clientId, 8),
      ai.usageToday(req.user.id, clientId),
    ]);
    const totals = features.reduce((a, f) => ({
      calls: a.calls + f.calls,
      failures: a.failures + f.failures,
      cacheHits: a.cacheHits + f.cache_hits,
      inputTokens: a.inputTokens + f.input_tokens,
      outputTokens: a.outputTokens + f.output_tokens,
      cost: a.cost + (f.est_cost_usd || 0),
      up: a.up + f.feedback_up,
      down: a.down + f.feedback_down,
    }), { calls: 0, failures: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, cost: 0, up: 0, down: 0 });
    res.set('Cache-Control', 'no-store');
    res.json({
      server: { enabled: globalEnabled(), defaultForAccounts: process.env.AI_DEFAULT_ENABLED === 'true', provider: providerInfo() },
      account: { enabled: access.enabled, reason: access.reason, setting },
      limits: { ...limits(), ...usageToday },
      jobs: {
        alerts: process.env.AI_ALERTS_ENABLED === 'true',
        weeklyReport: process.env.AI_REPORT_ENABLED === 'true',
        prewarm: process.env.AI_PREWARM_ENABLED === 'true',
      },
      usage: { days: 7, features, totals, daily },
      tokens: { averages, averagesDays: 90, series: { by: 'day', rows: tokenDays } },
      feedback: { up: totals.up, down: totals.down, recent: feedback },
      failures,
    });
  } catch (err) {
    logger.error('ai admin:', err.stack || err.message);
    res.status(500).json({ error: 'Could not load AI settings' });
  }
});

/**
 * Admin: one tiny call per tier to confirm the key, models and latency. Works before AI is turned on for the
 * account, so a new setup can be checked first.
 */
router.post('/ping', requireAdmin, async (req, res) => {
  if (!globalEnabled()) return res.status(409).json({ error: 'AI is off on the server (AI_ENABLED).', code: 'server_off' });
  if (!hasCredentials()) return res.status(409).json({ error: 'No AI credentials are configured.', code: 'no_credentials' });
  req.aiCtx = { userId: req.user.id, clientId: req.user.clientId || null };
  const results = {};
  for (const tier of Object.keys(tiers())) {
    try {
      const r = await ai.run({
        feature: 'ping',
        tier,
        system: 'You are a health check. Reply with the single word OK.',
        user: 'ping',
        maxTokens: tier === 'deep' ? 256 : 16,
        ctx: req.aiCtx,
      });
      results[tier] = { ok: true, model: r.model, latencyMs: r.latencyMs, firstTokenMs: r.firstTokenMs, reply: r.text.trim().slice(0, 20) };
    } catch (err) {
      results[tier] = { ok: false, code: err.code || 'error', error: err.message };
    }
  }
  res.json({ results });
});

/**
 * AI analysis of one saved preset.
 * Send Accept: text/event-stream for progressive events (facts, headline, result);
 * otherwise a single JSON response is returned.
 */
router.post('/preset-analysis', requireAuth, ai.requireAiEnabled, async (req, res) => {
  const stream = String(req.headers.accept || '').includes('text/event-stream');
  const controller = new AbortController();
  // Stop paying for the model call when the browser goes away.
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });

  let started = false;
  const emit = (event, data) => {
    if (!stream || res.writableEnded) return;
    if (!started) {
      started = true;
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform keeps the compression middleware from buffering the stream.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  try {
    const result = await analyzePreset({
      authorization: req.headers.authorization,
      ctx: req.aiCtx,
      body: req.body,
      emit,
      signal: controller.signal,
    });
    if (stream) return res.end();
    return res.json(result);
  } catch (err) {
    const status = err instanceof RequestError ? 400 : (err.status || 500);
    if (status >= 500 && !(err.code && err.code.startsWith('ai_'))) logger.error('preset analysis:', err.stack || err.message);
    const payload = { error: err instanceof RequestError || err.code ? err.message : 'Could not analyze this preset.', code: err.code || null };
    if (stream && started) {
      emit('error', payload);
      return res.end();
    }
    if (ai.sendAiError(res, err)) return undefined;
    return res.status(status).json(payload);
  }
});

/**
 * Admin: suggest which site or app each unmapped Google Ads campaign belongs to.
 * Rules always run; the model is only asked about unclear campaigns, and only when AI is on.
 * Pin a workspace with the X-Gam-Client-Id header, as the Google Ads accounts screen does.
 */
router.post('/mapping-suggestions', requireAdmin, async (req, res) => {
  const product = String(req.body?.product || '');
  if (!['adsense', 'admob', 'gam'].includes(product)) return res.status(400).json({ error: 'Unknown product' });
  try {
    const access = await ai.resolveAiAccess(req.user);
    const pin = req.headers['x-gam-client-id'];
    const data = await suggestMappings({
      product,
      client: req.client,
      adsAccountId: typeof req.body?.adsAccountId === 'string' ? req.body.adsAccountId : null,
      authorization: req.headers.authorization,
      headers: pin ? { 'x-gam-client-id': pin } : undefined,
      ai: access.enabled && req.body?.useAi !== false
        ? { userId: req.user.id, clientId: req.user.clientId || null }
        : null,
    });
    res.set('Cache-Control', 'no-store');
    return res.json(data);
  } catch (err) {
    logger.error('mapping suggestions:', err.stack || err.message);
    return res.status(500).json({ error: 'Could not build mapping suggestions.' });
  }
});

/**
 * Alerts for the account: problems found in last week's numbers across GAM, AdMob and AdSense.
 * If the account has not been scanned recently, opening the list starts a scan in the background.
 */
router.get('/alerts', requireAdmin, ai.requireAiEnabled, async (req, res) => {
  try {
    const accountId = await alerts.accountIdFor(req.user);
    if (!accountId) return res.json({ alerts: [], scanning: false });
    let scanning = false;
    if (await alerts.isScanDue(accountId)) {
      scanning = true;
      alerts.scanAccount({ user: req.user, authorization: req.headers.authorization })
        .catch((err) => logger.warn(`alert scan failed: ${err.message}`));
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ alerts: await alerts.listAlerts(accountId), scanning });
  } catch (err) {
    logger.error('alerts list:', err.message);
    return res.status(500).json({ error: 'Could not load alerts.' });
  }
});

/** Check now: scan and return the fresh list. */
router.post('/alerts/scan', requireAdmin, ai.requireAiEnabled, async (req, res) => {
  try {
    const accountId = await alerts.accountIdFor(req.user);
    if (!accountId) return res.json({ created: 0, alerts: [] });
    const result = await alerts.scanAccount({ user: req.user, authorization: req.headers.authorization });
    return res.json({ ...result, alerts: await alerts.listAlerts(accountId) });
  } catch (err) {
    logger.error('alerts scan:', err.stack || err.message);
    return res.status(500).json({ error: 'Could not check for problems right now.' });
  }
});

router.post('/alerts/:id/dismiss', requireAdmin, ai.requireAiEnabled, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid alert' });
  try {
    const accountId = await alerts.accountIdFor(req.user);
    const ok = accountId ? await alerts.dismissAlert(accountId, id, req.user.id) : false;
    return res.json({ ok });
  } catch (err) {
    logger.error('alerts dismiss:', err.message);
    return res.status(500).json({ error: 'Could not dismiss the alert.' });
  }
});

/** Admin: weekly reports for the account, newest first (headlines only). */
router.get('/reports', requireAdmin, ai.requireAiEnabled, async (req, res) => {
  try {
    const accountId = await accountIdFor(req.user);
    res.set('Cache-Control', 'no-store');
    return res.json({ reports: accountId ? await reports.listReports(accountId) : [] });
  } catch (err) {
    logger.error('reports list:', err.message);
    return res.status(500).json({ error: 'Could not load reports.' });
  }
});

router.get('/reports/:id', requireAdmin, ai.requireAiEnabled, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report' });
  try {
    const accountId = await accountIdFor(req.user);
    const report = accountId ? await reports.getReport(accountId, id) : null;
    if (!report) return res.status(404).json({ error: 'Report not found' });
    return res.json({ report });
  } catch (err) {
    logger.error('report get:', err.message);
    return res.status(500).json({ error: 'Could not load the report.' });
  }
});

/** Admin: write this week's report now (reuses one generated in the last 12 hours unless force is set). */
router.post('/reports/generate', requireAdmin, ai.requireAiEnabled, async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const accountId = await accountIdFor(req.user);
    if (!accountId) return res.status(400).json({ error: 'No account to report on' });
    const report = await reports.generateWeeklyReport({
      user: req.user,
      accountId,
      authorization: req.headers.authorization,
      ctx: req.aiCtx,
      force: req.body?.force === true,
      signal: controller.signal,
    });
    return res.json({ report });
  } catch (err) {
    logger.error('report generate:', err.stack || err.message);
    if (ai.sendAiError(res, err)) return undefined;
    return res.status(500).json({ error: 'Could not write the report right now.' });
  }
});

/**
 * Why earnings changed between a period and the one before it. Streams `drivers` (exact figures, immediately)
 * and `result` (the same plus the explanation).
 */
router.post('/explain-change', requireAuth, ai.requireAiEnabled, async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const { emit, isStarted } = openEvents(res);
  try {
    await explainChange({
      authorization: req.headers.authorization,
      ctx: req.aiCtx,
      body: req.body,
      emit,
      signal: controller.signal,
    });
    return res.end();
  } catch (err) {
    const known = err instanceof RequestError || err instanceof ExplainError || err.code;
    if (!known) logger.error('explain change:', err.stack || err.message);
    const status = err instanceof RequestError ? 400 : (err.status || 500);
    const payload = { error: known ? err.message : 'Could not explain this change.', code: err.code || null };
    if (isStarted()) {
      emit('error', payload);
      return res.end();
    }
    if (ai.sendAiError(res, err)) return undefined;
    return res.status(status).json(payload);
  }
});

/** Server-sent events for one response; nothing is sent until the first event. */
function openEvents(res) {
  let started = false;
  const emit = (event, data) => {
    if (res.writableEnded) return;
    if (!started) {
      started = true;
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };
  return { emit, isStarted: () => started };
}

/**
 * Ask a question about your data. Streams events: tool (a data lookup started), text (answer as it is
 * written; restart the visible answer when the turn number changes), done (final answer and steps).
 */
router.post('/ask', requireAuth, ai.requireAiEnabled, async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const { emit, isStarted } = openEvents(res);
  try {
    await askData({
      question: req.body?.question,
      history: req.body?.history,
      context: req.body?.context,
      authorization: req.headers.authorization,
      ctx: req.aiCtx,
      emit,
      signal: controller.signal,
    });
    return res.end();
  } catch (err) {
    if (!err.code) logger.error('ask data:', err.stack || err.message);
    const payload = { error: err.code ? err.message : 'Could not answer right now.', code: err.code || null };
    if (isStarted()) {
      emit('error', payload);
      return res.end();
    }
    if (ai.sendAiError(res, err)) return undefined;
    return res.status(err.status || 500).json(payload);
  }
});

module.exports = router;
