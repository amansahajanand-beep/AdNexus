/**
 * Factory: /api/admob and /api/adsense account + overview routes.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { usePublisherTenant } = require('../utils/publisherTenant');
const { getPendingSessionPublic, getPendingSession, deletePendingSession } = require('../models/oauthPendingStore');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const logger = require('../utils/logger');

function sparkFromTrend(trend, key) {
  return (trend || []).slice(-8).map((r) => ({ v: Number(r[key]) || 0 }));
}

function pctChange(curr, prev) {
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  if (!p) return c ? 100 : 0;
  return ((c - p) / Math.abs(p)) * 100;
}

function createPublisherApiRouter({
  product,
  store,
  isOAuthConfigured,
  resolveOAuthApp,
  redirectUri,
  buildAuthUrl,
  commitSelection,
  syncAll,
  syncAccount,
  enqueueSync,
  syncQueue,
  sumRange,
  trendRange,
  sumRollup,
  trendRollup,
  sumFiltered,
  trendFiltered,
  buildOverviewKpis,
  listFilterOptions,
  breakdownFn,
  tableFn,
  defaultBreakdownDim,
  defaultTableDim,
  queryParam,
  adminOnly = false,
  extendRouter = null,
  scoped = null,
}) {
  const router = express.Router();
  router.use(requireAuth);
  router.use(usePublisherTenant);
  // Role check only — re-running requireAuth would reset req.client to the GAM network.
  const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    return next();
  };
  // Domain users with a product scope may only use these read endpoints.
  const SCOPED_READ_PATHS = new Set(['/kpis', '/trend', '/overview', '/freshness', '/filters', '/breakdowns', '/table']);
  const isScopedUser = (req) => !!scoped && req.user?.role !== 'admin';
  if (adminOnly) {
    router.use((req, res, next) => {
      if (req.user?.role === 'admin') return next();
      if (scoped && req.method === 'GET' && SCOPED_READ_PATHS.has(req.path) && scoped.hasAccess(req.user)) {
        return next();
      }
      return res.status(403).json({ error: 'Admin access required' });
    });
  }

  const { buildVisibility, hasFlag } = require('../utils/permissions');

  const productAccessFlag = product === 'admob' ? 'canAccessAdMob' : 'canAccessAdSense';

  function inventoryFilterOpts(req) {
    return {
      apps: req.query.apps,
      formats: req.query.formats,
      countries: req.query.countries,
      platforms: req.query.platforms,
      sites: req.query.sites,
      adUnits: req.query.adUnits,
      adSources: req.query.adSources,
      adSourceInstances: req.query.adSourceInstances,
      mediationGroups: req.query.mediationGroups,
    };
  }

  function parseCsvList(raw) {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function hasInventoryFilters(inv) {
    return Object.values(inv || {}).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      return v != null && String(v).trim() !== '';
    });
  }
  router.use((req, res, next) => {
    // Admin account/OAuth routes still require admin; product flag gates all reads.
    const allowed = scoped ? scoped.hasAccess(req.user) : hasFlag(req.user, productAccessFlag);
    if (!allowed) {
      return res.status(403).json({ error: `${product === 'admob' ? 'AdMob' : 'AdSense'} access not permitted` });
    }
    return next();
  });

  function applyMetricPermissions(user, kpis = [], totals = {}) {
    const vis = buildVisibility(user);
    const hide = new Set();
    if (!vis.revenue) hide.add('earnings');
    if (!vis.impressions) hide.add('impressions');
    if (!vis.ctr) {
      hide.add('clicks');
      hide.add('ctr');
    }
    if (!vis.ecpm) {
      hide.add('ecpm');
      hide.add('rpm');
      hide.add('matchRate');
    }
    const filteredKpis = (kpis || []).filter((k) => !hide.has(k.key));
    const safeTotals = { ...totals };
    if (!vis.revenue) {
      delete safeTotals.earnings;
    }
    if (!vis.impressions) delete safeTotals.impressions;
    if (!vis.ctr) {
      delete safeTotals.clicks;
      delete safeTotals.ctr;
    }
    if (!vis.ecpm) {
      delete safeTotals.ecpm;
      delete safeTotals.rpm;
      delete safeTotals.match_rate;
    }
    return { kpis: filteredKpis, totals: safeTotals, visibility: {
      revenue: !!vis.revenue,
      impressions: !!vis.impressions,
      ctr: !!vis.ctr,
      ecpm: !!vis.ecpm,
    } };
  }

  async function resolveAccountContext(req) {
    const clientId = req.client?.id || req.user?.clientId;
    if (!clientId) return { error: 'No client context', status: 400 };
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    const accounts = await store.listAccounts(clientId);
    const active = accountId
      ? accounts.find((a) => a.id === accountId)
      : accounts.find((a) => a.isActive && a.hasRefreshToken) || accounts[0] || null;
    return { clientId, accounts, active, storeAccountId: active?.id || null };
  }

  function resolveRange(req) {
    const end = String(req.query.endDate || todayInTZ());
    const start = String(req.query.startDate || shiftYMD(end, -6));
    const days = Math.max(
      1,
      Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1
    );
    // Optional explicit compare window (Dashboard-style prior / last week / last month / custom)
    const cmpStart = req.query.compareStartDate ? String(req.query.compareStartDate) : null;
    const cmpEnd = req.query.compareEndDate ? String(req.query.compareEndDate) : null;
    let prevEnd = shiftYMD(start, -1);
    let prevStart = shiftYMD(prevEnd, -(days - 1));
    if (cmpStart && cmpEnd && /^\d{4}-\d{2}-\d{2}$/.test(cmpStart) && /^\d{4}-\d{2}-\d{2}$/.test(cmpEnd) && cmpEnd >= cmpStart) {
      prevStart = cmpStart;
      prevEnd = cmpEnd;
    }
    return { start, end, prevStart, prevEnd, days };
  }

  // ── Scoped (domain user) reads: grain facts limited to assigned publishers/apps/ad units ──
  const { getDateRestriction, clampDateRange } = require('../utils/dateRestriction');
  const SCOPED_FILTER_KEYS = {
    app: 'apps', ad_unit: 'adUnits', format: 'formats', country: 'countries', platform: 'platforms',
  };
  // Never expose publisher ids / account names to domain users.
  const SCOPED_ACCOUNT = { id: null, descriptiveName: product === 'admob' ? 'AdMob' : 'AdSense' };

  async function resolveScopedContext(req) {
    const scope = scoped.getScope(req.user);
    const clientId = req.client?.id;
    const allowed = new Set(scope.accountIds || []);
    const accounts = (await store.listAccounts(clientId)).filter((a) => allowed.has(a.id));
    return { clientId, accounts, scope: { ...scope, accountIds: accounts.map((a) => a.id) } };
  }

  function scopedFilters(req, scope) {
    if (!hasFlag(req.user, 'canUseFilters')) return {};
    const allowed = new Set(scope.filters || []);
    const out = {};
    for (const [dim, key] of Object.entries(SCOPED_FILTER_KEYS)) {
      if (allowed.has(dim) && req.query[key]) out[key] = req.query[key];
    }
    return out;
  }

  function scopedRange(req) {
    const r = resolveRange(req);
    const restriction = getDateRestriction(req.user);
    if (!restriction?.startDate) return r;
    const cur = clampDateRange(r.start, r.end, restriction);
    const prev = clampDateRange(r.prevStart, r.prevEnd, restriction);
    return { ...r, start: cur.startDate, end: cur.endDate, prevStart: prev.startDate, prevEnd: prev.endDate };
  }

  function gateRow(user, row) {
    const vis = buildVisibility(user);
    const out = { ...row };
    if (!vis.revenue) delete out.earnings;
    if (!vis.impressions) delete out.impressions;
    if (!vis.ctr) {
      delete out.clicks;
      delete out.ctr;
    }
    if (!vis.ecpm) {
      delete out.ecpm;
      delete out.rpm;
      delete out.match_rate;
    }
    return out;
  }

  function latestSync(accounts) {
    return accounts.reduce((best, a) => (
      a.lastSyncAt && (!best || new Date(a.lastSyncAt) > new Date(best)) ? a.lastSyncAt : best
    ), null);
  }

  async function loadScopedKpiPayload(req) {
    const ctx = await resolveScopedContext(req);
    const { start, end, prevStart, prevEnd } = scopedRange(req);
    const base = { scope: ctx.scope, filters: scopedFilters(req, ctx.scope) };
    const [curr, prev, trend] = await Promise.all([
      scoped.totals(ctx.clientId, ctx.accounts, { ...base, start, end }),
      scoped.totals(ctx.clientId, ctx.accounts, { ...base, start: prevStart, end: prevEnd }),
      scoped.trend(ctx.clientId, ctx.accounts, { ...base, start, end }),
    ]);
    const hasData = Number(curr.earnings || curr.impressions || 0) > 0 || trend.length > 0;
    const gated = applyMetricPermissions(req.user, buildOverviewKpis(curr, prev, trend), curr);
    return {
      isSample: !hasData,
      source: 'scoped-grain',
      account: SCOPED_ACCOUNT,
      accounts: [],
      currency: curr.currency || 'USD',
      range: { startDate: start, endDate: end, compareStart: prevStart, compareEnd: prevEnd },
      totals: gated.totals,
      previous: applyMetricPermissions(req.user, [], prev).totals,
      kpis: gated.kpis,
      trend: trend.map((t) => gateRow(req.user, t)),
      visibility: gated.visibility,
      lastSyncAt: latestSync(ctx.accounts),
      lastSyncError: null,
    };
  }

  async function loadKpiPayload(req) {
    if (isScopedUser(req)) return loadScopedKpiPayload(req);
    const ctx = await resolveAccountContext(req);
    if (ctx.error) throw Object.assign(new Error(ctx.error), { status: ctx.status });
    const { start, end, prevStart, prevEnd } = resolveRange(req);
    const inv = inventoryFilterOpts(req);
    const useFiltered = hasInventoryFilters(inv) && typeof sumFiltered === 'function';
    const opts = { accountId: ctx.storeAccountId, startDate: start, endDate: end, ...inv };
    const prevOpts = { accountId: ctx.storeAccountId, startDate: prevStart, endDate: prevEnd, ...inv };

    let curr;
    let prev;
    let trend;
    let source = 'rollups';

    if (useFiltered) {
      curr = await sumFiltered(ctx.clientId, opts);
      prev = await sumFiltered(ctx.clientId, prevOpts);
      trend = typeof trendFiltered === 'function'
        ? await trendFiltered(ctx.clientId, opts)
        : [];
      source = 'filtered-dims';
      if (!curr) curr = { earnings: 0, impressions: 0, clicks: 0, ad_requests: 0, matched_requests: 0 };
      if (!prev) prev = { earnings: 0, impressions: 0, clicks: 0, ad_requests: 0, matched_requests: 0 };
      if (!trend) trend = [];
    } else {
      // Prefer rollups; fall back to fact tables if rollups empty
      curr = sumRollup
        ? await sumRollup(ctx.clientId, opts)
        : await sumRange(ctx.clientId, opts);
      prev = sumRollup
        ? await sumRollup(ctx.clientId, prevOpts)
        : await sumRange(ctx.clientId, prevOpts);
      trend = trendRollup
        ? await trendRollup(ctx.clientId, opts)
        : await trendRange(ctx.clientId, opts);

      const rollupEmpty = !Number(curr.earnings || curr.impressions || 0) && !(trend || []).length;
      if (rollupEmpty && sumRollup) {
        curr = await sumRange(ctx.clientId, opts);
        prev = await sumRange(ctx.clientId, prevOpts);
        trend = await trendRange(ctx.clientId, opts);
        source = 'facts';
      }
    }

    const hasData = Number(curr.earnings || curr.impressions || 0) > 0 || (trend || []).length > 0;
    let kpis = buildOverviewKpis(curr, prev, trend);
    const gated = applyMetricPermissions(req.user, kpis, curr);
    kpis = gated.kpis;
    return {
      isSample: !hasData,
      source,
      account: ctx.active || null,
      accounts: ctx.accounts,
      currency: curr.currency || ctx.active?.currencyCode || 'USD',
      range: { startDate: start, endDate: end, compareStart: prevStart, compareEnd: prevEnd },
      totals: gated.totals,
      previous: prev,
      kpis,
      trend,
      visibility: gated.visibility,
      lastSyncAt: ctx.active?.lastSyncAt || null,
      lastSyncError: ctx.active?.lastSyncError || null,
    };
  }

  router.get('/health', requireAdmin, (req, res) => {
    const oauth = resolveOAuthApp(req.client);
    res.json({
      ok: true,
      product,
      oauthConfigured: isOAuthConfigured(req.client),
      oauthSource: oauth.source,
      redirectUri: redirectUri(),
    });
  });

  router.get('/accounts', requireAdmin, async (req, res) => {
    try {
      const clientId = req.client?.id || req.user.clientId;
      const accounts = await store.listAccounts(clientId);
      res.json({ accounts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/accounts/oauth-url', requireAdmin, async (req, res) => {
    try {
      if (!isOAuthConfigured(req.client)) {
        return res.status(400).json({
          error: `${product === 'admob' ? 'AdMob' : 'AdSense'} OAuth not configured. `
            + `Set GOOGLE_${product === 'admob' ? 'ADMOB' : 'ADSENSE'}_CLIENT_ID/SECRET `
            + 'or use the same Google OAuth credentials as GAM.',
        });
      }
      const url = buildAuthUrl(req.client, {
        clientId: req.client.id,
        mode: 'connect',
      });
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/accounts/:id/oauth-url', requireAdmin, async (req, res) => {
    try {
      const account = await store.getAccountById(req.params.id);
      if (!account || account.clientId !== req.client.id) {
        return res.status(404).json({ error: 'Account not found' });
      }
      const url = buildAuthUrl(req.client, {
        clientId: req.client.id,
        mode: 'reconnect',
        publisherAccountId: account.id,
      });
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/oauth/pending/:id', requireAdmin, async (req, res) => {
    try {
      const session = await getPendingSessionPublic(req.params.id);
      if (!session || session.product !== product) {
        return res.status(404).json({ error: 'OAuth session expired or not found. Connect again.' });
      }
      if (session.clientId && session.clientId !== req.client.id) {
        return res.status(403).json({ error: 'OAuth session belongs to another client.' });
      }
      res.json({
        sessionId: session.id,
        accounts: session.candidates || [],
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/oauth/pending/:id/select', requireAdmin, async (req, res) => {
    try {
      const session = await getPendingSession(req.params.id);
      if (!session || session.product !== product) {
        return res.status(404).json({ error: 'OAuth session expired or not found. Connect again.' });
      }
      if (session.clientId && session.clientId !== req.client.id) {
        return res.status(403).json({ error: 'OAuth session belongs to another client.' });
      }
      const accountId = String(req.body?.accountId || '').trim();
      const candidate = (session.candidates || []).find((c) => String(c.accountId) === accountId);
      if (!candidate) {
        return res.status(400).json({ error: 'Selected account is not in this OAuth session.' });
      }
      const account = await commitSelection(req.client, {
        accountId: candidate.accountId,
        descriptiveName: candidate.descriptiveName,
        currencyCode: candidate.currencyCode,
        reportingTimeZone: candidate.reportingTimeZone || null,
        refreshToken: session.refreshToken,
      });
      await deletePendingSession(session.id);

      // Kick off initial sync (non-blocking)
      try {
        await enqueueSync(req.client, syncQueue, {
          jobIdPrefix: `${product}-sync-connect-${account.id.slice(0, 8)}`,
          priority: 2,
        });
      } catch (e) {
        logger.warn(`${product} post-connect sync enqueue:`, e.message);
      }

      res.json({ ok: true, account });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/accounts/:id', requireAdmin, async (req, res) => {
    try {
      const account = await store.getAccountById(req.params.id);
      if (!account || account.clientId !== req.client.id) {
        return res.status(404).json({ error: 'Account not found' });
      }
      const updated = await store.updateAccount(account.id, {
        descriptiveName: req.body?.descriptiveName,
        isActive: req.body?.isActive,
      });
      res.json({ account: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/accounts/:id', requireAdmin, async (req, res) => {
    try {
      const account = await store.getAccountById(req.params.id);
      if (!account || account.clientId !== req.client.id) {
        return res.status(404).json({ error: 'Account not found' });
      }
      await store.hardDeleteAccount(account.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sync', requireAdmin, async (req, res) => {
    try {
      const end = req.body?.endDate || todayInTZ();
      const lookback = parseInt(
        process.env[product === 'admob' ? 'ADMOB_SYNC_LOOKBACK_DAYS' : 'ADSENSE_SYNC_LOOKBACK_DAYS'] || '30',
        10
      ) || 30;
      const start = req.body?.startDate || shiftYMD(end, -(lookback - 1));
      const result = await enqueueSync(req.client, syncQueue, {
        startDate: start,
        endDate: end,
        jobIdPrefix: `${product}-sync-manual-${req.client.id.slice(0, 8)}-${end}`,
        priority: 3,
      });
      if (result.ranInline) {
        return res.json({
          ok: true,
          ...result,
          message: `Synced ${result.accounts} account(s).`,
        });
      }
      res.json({
        ok: true,
        queued: true,
        ...result,
        message: `Queued sync for ${result.jobs} account(s).`,
      });
    } catch (err) {
      logger.error(`${product} sync:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/accounts/:id/sync', requireAdmin, async (req, res) => {
    try {
      const account = await store.getAccountById(req.params.id);
      if (!account || account.clientId !== req.client.id) {
        return res.status(404).json({ error: 'Account not found' });
      }
      const end = req.body?.endDate || todayInTZ();
      const lookback = parseInt(
        process.env[product === 'admob' ? 'ADMOB_SYNC_LOOKBACK_DAYS' : 'ADSENSE_SYNC_LOOKBACK_DAYS'] || '30',
        10
      ) || 30;
      const start = req.body?.startDate || shiftYMD(end, -(lookback - 1));
      const result = await syncAccount(account, { startDate: start, endDate: end, gamClient: req.client });
      const rows = typeof result === 'object' ? result.rows : result;
      res.json({ ok: true, rows, startDate: start, endDate: end });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Lean KPI payload for dashboard cards (prefers rollups). */
  router.get('/kpis', async (req, res) => {
    try {
      const payload = await loadKpiPayload(req);
      res.json({
        isSample: payload.isSample,
        source: payload.source,
        account: payload.account,
        currency: payload.currency,
        range: payload.range,
        kpis: payload.kpis,
        totals: payload.totals,
        lastSyncAt: payload.lastSyncAt,
        lastSyncError: payload.lastSyncError,
      });
    } catch (err) {
      const status = err.status || 500;
      logger.error(`${product} kpis:`, err.message);
      res.status(status).json({ error: err.message });
    }
  });

  /** Daily trend series (prefers rollups). */
  router.get('/trend', async (req, res) => {
    try {
      const payload = await loadKpiPayload(req);
      res.json({
        isSample: payload.isSample,
        source: payload.source,
        account: payload.account,
        currency: payload.currency,
        range: payload.range,
        trend: payload.trend,
      });
    } catch (err) {
      const status = err.status || 500;
      logger.error(`${product} trend:`, err.message);
      res.status(status).json({ error: err.message });
    }
  });

  /** Full dashboard overview — KPIs + trend + account list. */
  router.get('/overview', async (req, res) => {
    try {
      const payload = await loadKpiPayload(req);
      res.set('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err) {
      const status = err.status || 500;
      logger.error(`${product} overview:`, err.message);
      res.status(status).json({ error: err.message });
    }
  });

  /** Sync freshness for sidebar / page chips. */
  router.get('/freshness', async (req, res) => {
    try {
      if (isScopedUser(req)) {
        const ctx = await resolveScopedContext(req);
        return res.json({
          product,
          lastSyncAt: latestSync(ctx.accounts),
          accountCount: ctx.accounts.length,
          accountId: null,
          accountLabel: SCOPED_ACCOUNT.descriptiveName,
          needsReconnect: false,
          errors: [],
          accounts: [],
        });
      }
      const clientId = req.client?.id || req.user?.clientId;
      if (!clientId) return res.status(400).json({ error: 'No client context' });
      const accounts = await store.listAccounts(clientId);
      const connected = accounts.filter((a) => a.hasRefreshToken && a.isActive);
      const requestedId = req.query.accountId ? String(req.query.accountId) : null;
      const requested = requestedId
        ? connected.find((a) => a.id === requestedId) || accounts.find((a) => a.id === requestedId)
        : null;
      let latest = null;
      let latestAccount = null;
      for (const a of connected) {
        if (!a.lastSyncAt) continue;
        if (!latest || new Date(a.lastSyncAt) > new Date(latest)) {
          latest = a.lastSyncAt;
          latestAccount = a;
        }
      }
      const errors = connected.filter((a) => a.lastSyncError).map((a) => ({
        id: a.id,
        name: a.descriptiveName || a.accountId,
        error: a.lastSyncError,
      }));
      const active = requested || latestAccount || connected[0] || null;
      res.json({
        product,
        lastSyncAt: requested?.lastSyncAt || latest,
        accountCount: connected.length,
        accountId: active?.id || null,
        accountLabel: active
          ? (active.descriptiveName || active.accountId || null)
          : null,
        needsReconnect: connected.some((a) => !a.hasRefreshToken),
        errors,
        accounts: connected.map((a) => ({
          id: a.id,
          accountId: a.accountId,
          descriptiveName: a.descriptiveName || a.accountId,
          lastSyncAt: a.lastSyncAt,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Filter catalog for UI multi-selects. */
  router.get('/filters', async (req, res) => {
    try {
      if (typeof listFilterOptions !== 'function') {
        return res.json({ options: {} });
      }
      if (!hasFlag(req.user, 'canUseFilters') && req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Filters not permitted' });
      }
      if (isScopedUser(req)) {
        const sctx = await resolveScopedContext(req);
        const { start, end } = scopedRange(req);
        const options = await scoped.filterOptions(
          sctx.clientId,
          { scope: sctx.scope, start, end },
          sctx.scope.filters || []
        );
        return res.json({
          account: SCOPED_ACCOUNT,
          range: { startDate: start, endDate: end },
          allowedFilters: sctx.scope.filters || [],
          options,
        });
      }
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { start, end } = resolveRange(req);
      const options = await listFilterOptions(ctx.clientId, {
        accountId: ctx.storeAccountId,
        startDate: start,
        endDate: end,
      });
      res.json({
        account: ctx.active,
        range: { startDate: start, endDate: end },
        options,
      });
    } catch (err) {
      logger.error(`${product} filters:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /** Breakdown chart data by dimension. */
  router.get('/breakdowns', async (req, res) => {
    try {
      if (typeof breakdownFn !== 'function') {
        return res.json({ rows: [] });
      }
      if (isScopedUser(req)) {
        const sctx = await resolveScopedContext(req);
        const { start, end } = scopedRange(req);
        const dim = String(req.query.dim || defaultBreakdownDim || 'app');
        const allowed = (sctx.scope.filters || []).includes(dim);
        const rows = allowed
          ? await scoped.breakdown(
            sctx.clientId,
            sctx.accounts,
            { scope: sctx.scope, filters: scopedFilters(req, sctx.scope), start, end },
            dim,
            req.query.limit || 20
          )
          : [];
        res.set('Cache-Control', 'no-store');
        return res.json({
          dim,
          range: { startDate: start, endDate: end },
          isSample: !rows.length,
          rows: rows.map((r) => gateRow(req.user, r)),
        });
      }
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { start, end } = resolveRange(req);
      const dim = String(req.query.dim || defaultBreakdownDim || 'app');
      const rows = await breakdownFn(ctx.clientId, {
        accountId: ctx.storeAccountId,
        startDate: start,
        endDate: end,
        dimKind: dim,
        limit: req.query.limit || 20,
        apps: req.query.apps,
        formats: req.query.formats,
        countries: req.query.countries,
        platforms: req.query.platforms,
        sites: req.query.sites,
        adUnits: req.query.adUnits,
        adSources: req.query.adSources,
        adSourceInstances: req.query.adSourceInstances,
        mediationGroups: req.query.mediationGroups,
      });
      const vis = buildVisibility(req.user);
      const safe = (rows || []).map((r) => {
        const out = { ...r };
        if (!vis.revenue) delete out.earnings;
        if (!vis.impressions) delete out.impressions;
        if (!vis.ctr) {
          delete out.clicks;
          delete out.ctr;
        }
        if (!vis.ecpm) {
          delete out.ecpm;
          delete out.rpm;
        }
        return out;
      });
      res.set('Cache-Control', 'no-store');
      res.json({
        dim,
        range: { startDate: start, endDate: end },
        isSample: !safe.length,
        rows: safe,
      });
    } catch (err) {
      logger.error(`${product} breakdowns:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /** Detail table rows. */
  router.get('/table', async (req, res) => {
    try {
      if (typeof tableFn !== 'function') {
        return res.json({ rows: [] });
      }
      if (isScopedUser(req)) {
        const sctx = await resolveScopedContext(req);
        const { start, end } = scopedRange(req);
        const requestedDim = String(req.query.dim || defaultTableDim || 'ad_unit');
        const allowedDims = sctx.scope.filters || [];
        const opts = { scope: sctx.scope, filters: scopedFilters(req, sctx.scope), start, end };
        let dim = requestedDim;
        let rows;
        if (dim !== 'date' && !allowedDims.includes(dim)) dim = allowedDims[0] || 'date';
        if (dim === 'date') {
          const trend = await scoped.trend(sctx.clientId, sctx.accounts, opts);
          rows = trend.map((t) => ({ name: t.date, ...t })).reverse();
        } else {
          rows = await scoped.breakdown(sctx.clientId, sctx.accounts, opts, dim, Math.min(parseInt(req.query.limit, 10) || 100, 500));
        }
        const vis = buildVisibility(req.user);
        res.set('Cache-Control', 'no-store');
        return res.json({
          dim,
          requestedDim,
          range: { startDate: start, endDate: end },
          isSample: !rows.length,
          rows: rows.map((r) => gateRow(req.user, r)),
          visibility: {
            revenue: !!vis.revenue,
            impressions: !!vis.impressions,
            ctr: !!vis.ctr,
            ecpm: !!vis.ecpm,
          },
        });
      }
      const ctx = await resolveAccountContext(req);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { start, end } = resolveRange(req);
      const dim = String(req.query.dim || defaultTableDim || 'ad_unit');
      const raw = await tableFn(ctx.clientId, {
        accountId: ctx.storeAccountId,
        startDate: start,
        endDate: end,
        dimKind: dim,
        limit: req.query.limit || 100,
        apps: req.query.apps,
        formats: req.query.formats,
        countries: req.query.countries,
        platforms: req.query.platforms,
        sites: req.query.sites,
        adUnits: req.query.adUnits,
        adSources: req.query.adSources,
        adSourceInstances: req.query.adSourceInstances,
        mediationGroups: req.query.mediationGroups,
      });
      const rows = Array.isArray(raw) ? raw : (raw?.rows || []);
      const resolvedDim = raw?.resolvedDim || dim;
      const vis = buildVisibility(req.user);
      const safe = (rows || []).map((r) => {
        const out = { name: r.name, ...r };
        if (!vis.revenue) delete out.earnings;
        if (!vis.impressions) delete out.impressions;
        if (!vis.ctr) {
          delete out.clicks;
          delete out.ctr;
        }
        if (!vis.ecpm) {
          delete out.ecpm;
          delete out.rpm;
        }
        return out;
      });
      res.set('Cache-Control', 'no-store');
      res.json({
        dim: resolvedDim,
        requestedDim: dim,
        range: { startDate: start, endDate: end },
        isSample: !safe.length,
        rows: safe,
        visibility: {
          revenue: !!vis.revenue,
          impressions: !!vis.impressions,
          ctr: !!vis.ctr,
          ecpm: !!vis.ecpm,
        },
      });
    } catch (err) {
      logger.error(`${product} table:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  if (typeof extendRouter === 'function') {
    extendRouter(router, { resolveAccountContext, resolveRange, parseCsvList, store });
  }

  return router;
}

module.exports = {
  createPublisherApiRouter,
  sparkFromTrend,
  pctChange,
};
