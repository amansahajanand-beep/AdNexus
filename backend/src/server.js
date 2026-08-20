require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/session');
const usersRoutes = require('./routes/users');
const domainsRoutes = require('./routes/domains');
const reportsRoutes = require('./routes/reports');
const ordersRoutes = require('./routes/orders');
const inventoryRoutes = require('./routes/inventory');
const networkRoutes = require('./routes/network');
const { initDB } = require('./models/userStore');
const onboardRoutes = require('./routes/onboard');
const clientsRoutes = require('./routes/clients');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Memory monitoring ───────────────────────────────────────────────
console.log('[MEMORY] Memory monitor started');

setInterval(() => {
  const m = process.memoryUsage();

  console.log(
    `[MEMORY] RSS=${(m.rss / 1024 / 1024).toFixed(0)}MB ` +
    `HeapUsed=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB ` +
    `HeapTotal=${(m.heapTotal / 1024 / 1024).toFixed(0)}MB ` +
    `External=${(m.external / 1024 / 1024).toFixed(0)}MB ` +
    `ArrayBuffers=${(m.arrayBuffers / 1024 / 1024).toFixed(0)}MB`
  );
}, 10000);

// Trust the first proxy hop so express-rate-limit can read X-Forwarded-For safely
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(compression());
app.use(express.json());

// CORS — compare without trailing slash (some proxies send Origin with `/`)
const normalizeOrigin = (o) => String(o || '').replace(/\/$/, '');
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:3000',
  'http://localhost:3099',
  'https://dashboard.brainfungames.com',
  'https://www.dashboard.brainfungames.com',
  ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
].map(normalizeOrigin);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests without Origin header (server-to-server, curl, etc.)
    if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) {
      return callback(null, true);
    }
    // Deny without throwing — avoids noisy "Unhandled error" 500s
    logger.warn(`CORS blocked origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
}));

// Rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
//   message: { error: 'Too many requests, please try again later.' }
// });
// app.use('/api/', limiter);

// ── Request timing logger ─────────────────────────────────────────────────────
// Logs every request with method, path, status, and duration.
// >5s requests are logged as WARN so they stand out in the console.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const slow = ms > 5000;
    logger[slow ? 'warn' : 'info'](
      `${req.method} ${req.path} → ${res.statusCode} in ${ms}ms${slow ? ' ⚠ SLOW (GAM?)' : ''}`
    );
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function startServer() {
  try {
    const { initSchema } = require('./db');
    await initSchema();
  } catch (e) {
    logger.warn('PostgreSQL schema init failed (non-fatal, continuing):', e.message);
  }

  try {
    await initDB();
  } catch (e) {
    logger.error(
      'User/session schema init failed — login will not work until tables users + user_sessions exist:',
      e.message
    );
    if (process.env.USE_PG_USERS === 'true') {
      throw e;
    }
  }

  // Routes
  app.use('/auth', authRoutes);              // GAM Google OAuth helper
  app.use('/api/onboard', onboardRoutes);    // Public client self-onboard
  app.use('/api/clients', clientsRoutes);    // Client admin credential settings
  app.use('/api/auth', sessionRoutes);       // Dashboard user login/session
  app.use('/api/users', usersRoutes);        // Admin user management
  app.use('/api/domains', domainsRoutes);    // Domain / channel catalogue
  app.use('/api/reports', reportsRoutes);
  app.use('/api/orders', ordersRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/network', networkRoutes);

  // Global error handler
  app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(err.status || 500).json({
      error: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  });

  app.listen(PORT, async () => {
    logger.info(`AdNexus backend running on port ${PORT}`);

    setImmediate(async () => {
      try {
        const { finishTenantBackfill } = require('./db');
        await finishTenantBackfill();
      } catch (e) {
        logger.warn('Tenant client_id backfill failed (non-fatal):', e.message);
      }
    });

    setImmediate(async () => {
      try {
        const { listActiveClients } = require('./models/clientStore');
        const { runWithClient } = require('./utils/clientContext');
        const { backfillAllRollups } = require('./services/gamSyncService');
        const clients = await listActiveClients();
        for (const client of clients) {
          await runWithClient(client, async () => {
            const n = await backfillAllRollups('startup-rollup');
            if (n > 0) logger.info(`Startup rollup backfill client=${client.id.slice(0, 8)} wrote ≈${n} kpi row(s)`);
          });
        }
      } catch (e) {
        logger.warn('Startup rollup backfill failed (non-fatal):', e.message);
      }
    });

    // ── Redis connection (lazy, non-blocking)
    if (process.env.SYNC_DISABLED !== 'true') {
      try {
        const { redis } = require('./redisClient');
        await redis.connect().catch(() => {}); // already connected if lazyConnect resolved
      } catch (e) {
        logger.warn('Redis connect failed (non-fatal):', e.message);
      }
    }

    // ── BullMQ workers (hourly DB sync + on-demand report jobs) ────────────────
    if (process.env.SYNC_DISABLED !== 'true' && process.env.RUN_IN_PROCESS_WORKERS !== 'false') {
      try {
        const { startWorker, startReportWorker } = require('./workers/gamSyncWorker');
        startWorker();
        startReportWorker();
      } catch (e) {
        logger.warn('BullMQ worker failed to start (non-fatal):', e.message);
      }
    } else if (process.env.RUN_IN_PROCESS_WORKERS === 'false') {
      logger.info('In-process BullMQ workers skipped (RUN_IN_PROCESS_WORKERS=false)');
    }

    // ── Cron jobs ─────────────────────────────────────────────────────────────
    if (process.env.SYNC_DISABLED !== 'true') {
      try {
        const { startCron } = require('./cron');
        startCron();
      } catch (e) {
        logger.warn('Cron start failed (non-fatal):', e.message);
      }
    }

    // Re-fetch present + past when country/device dimensions are missing.
    if (process.env.SYNC_DISABLED !== 'true') {
      setImmediate(async () => {
        try {
          const { listActiveClients } = require('./models/clientStore');
          const { runWithClient } = require('./utils/clientContext');
          const clients = await listActiveClients();
          if (!clients.length) {
            logger.info('Startup sync skipped — no active GAM clients');
            return;
          }
          for (const client of clients) {
            await runWithClient(client, async () => {
          const {
            presentHasCountryAndDevice,
            listDatesMissingRichDims,
            syncDateRangeFromGAM,
          } = require('./services/gamSyncService');
          const { todayInTZ, historicalRangeForPresets } = require('./utils/datetime');
          const { gamSyncQueue } = require('./queues/gamSync');
          const today = todayInTZ();
          const hist = historicalRangeForPresets();
          const redisOk = process.env.REDIS_DISABLED !== 'true' && process.env.REDIS_URL;
          const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000));

          const presentRich = await presentHasCountryAndDevice();
          if (!presentRich) {
            logger.info(`Present sync: today (${today}) missing from report_present — enqueue lean sync-today`);
            if (redisOk) {
              await gamSyncQueue.add('sync-today', {
                date: today,
                includeFull: false,
                clientId: client.id,
              }, {
                jobId: `sync-today-${client.id.slice(0, 8)}-${today}-${hourSlot}`,
                priority: 1,
                attempts: 3,
                backoff: { type: 'exponential', delay: 10000 },
              });
              logger.info('Present sync: enqueued lean sync-today → report_present');
            } else {
              await syncDateRangeFromGAM(today, today, 'sync-today');
              logger.info('Present sync: inline lean sync-today complete → report_present');
            }
          } else {
            logger.info(`Present sync: report_present already has today's (${today}) country + device rows`);
          }

          // Past window in report_daily only (yesterday / 7d / 30d). Lean — never block today.
          const missing = await listDatesMissingRichDims(hist.startDate, hist.endDate);
          if (missing.length) {
            logger.info(
              `Historical sync: ${missing.length} day(s) missing in report_daily `
              + `(${missing[0]} → ${missing[missing.length - 1]}).`
            );
            if (redisOk) {
              await gamSyncQueue.add('sync-backfill', {
                startDate: missing[0],
                endDate: missing[missing.length - 1],
                dates: missing,
                includeFull: false,
                clientId: client.id,
              }, {
                jobId: `sync-backfill-lean-${client.id.slice(0, 8)}-${today}`,
                priority: 10,
                attempts: 2,
                backoff: { type: 'fixed', delay: 60000 },
              });
              logger.info('Historical sync: enqueued lean sync-backfill → report_daily');
            } else {
              await syncDateRangeFromGAM(missing[0], missing[missing.length - 1], 'sync-backfill-inline');
              logger.info('Historical sync: inline lean backfill complete → report_daily');
            }
          } else {
            logger.info(
              `Historical sync: report_daily complete for ${hist.startDate} → ${hist.endDate}`
            );
          }
            });
          }
        } catch (e) {
          logger.warn('Country/device present+historical sync failed (non-fatal):', e.message);
        }
      });
    }

    // Pre-warm durable caches (filter-catalog from Postgres survives restart without Redis).
    setImmediate(async () => {
      try {
        const { cache } = require('./gamClient');
        const { kvGet } = require('./utils/kvCache');
        const { CATALOG_CACHE_KEY } = require('./utils/inventoryCatalog');
        const hit = await kvGet(CATALOG_CACHE_KEY);
        if (hit?.payload?.rows?.length) {
          cache.set(CATALOG_CACHE_KEY, hit.payload, parseInt(process.env.CACHE_TTL, 10) || 3600);
          logger.info(`Cache warm-up: filter catalog from Postgres (${hit.payload.rows.length} rows)`);
        } else {
          logger.info('Cache warm-up: no persisted filter catalog yet (first GAM fetch will save it)');
        }
      } catch (e) {
        logger.warn('Cache warm-up (catalog) failed (non-fatal):', e.message);
      }
    });

    // Pre-warm the most common cache entries in the background so the first
    // real user request is served from cache instead of waiting for GAM.
    setImmediate(async () => {
        try {
          const { cache } = require('./gamClient');
          // Check if cache already has today's data (e.g. after a hot reload).
          const todayKey = cache.keys().find(k => k.startsWith('report_dashboard_full_') || k.startsWith('report_detailed_full_'));
          if (todayKey) {
            logger.info('Cache warm-up skipped — data already present');
            return;
          }
          logger.info('Cache warm-up: fetching today\'s programmatic overview…');
          const { todayInTZ } = require('./utils/datetime');
          const today = todayInTZ();
          // Hit the overview endpoint internally via a lightweight HTTP call
          // so the in-flight dedup map is shared and the response is cached.
          const axios = require('axios');
          const warmUrl = `http://localhost:${PORT}/api/reports/dashboard/overview?startDate=${today}&endDate=${today}`;
          const { getAllUsers, getUserById } = require('./models/userStore');
          const { generateTokens } = require('./middleware/auth');
          const users = await getAllUsers();
          const admin = users.find(u => u.role === 'admin');
          if (!admin) return;
          const fullAdmin = await getUserById(admin.id);
          if (!fullAdmin?.activeSessionId) {
            logger.info('Cache warm-up skipped — no active admin session');
            return;
          }
          const { accessToken: token } = generateTokens(fullAdmin, fullAdmin.activeSessionId);
          await axios.get(warmUrl, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 180000,
          }).catch(e => logger.warn('Cache warm-up overview error:', e.message));
          logger.info('Cache warm-up: done');
        } catch (e) {
          logger.warn('Cache warm-up failed (non-fatal):', e.message);
        }
      });
  });
}

startServer().catch((err) => {
  logger.error('Server failed to start:', err);
  process.exit(1);
});

module.exports = app;

