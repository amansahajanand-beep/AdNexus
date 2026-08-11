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

const app = express();
const PORT = process.env.PORT || 3001;

// Trust the first proxy hop so express-rate-limit can read X-Forwarded-For safely
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(compression());
app.use(express.json());

// CORS
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://dashboard.mediamonetix.com'
  ],
  credentials: true
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

// Routes
app.use('/auth', authRoutes);              // GAM Google OAuth
app.use('/api/auth', sessionRoutes);       // Dashboard user login/session
app.use('/api/users', usersRoutes);        // Admin user management
app.use('/api/domains', domainsRoutes);    // Domain / channel catalogue
app.use('/api/reports', reportsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/network', networkRoutes);

// Ensure the user database exists (seeds default admin / Admin@123)
Promise.resolve(initDB()).catch((e) => logger.warn('initDB failed (non-fatal):', e.message));

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

async function startServer() {
  app.listen(PORT, async () => {
  logger.info(`AdNexus backend running on port ${PORT}`);

  // ── PostgreSQL schema (safe: CREATE IF NOT EXISTS) ────────────────────────
  if (process.env.SYNC_DISABLED !== 'true') {
    try {
      const { initSchema } = require('./db');
      await initSchema();
    } catch (e) {
      logger.warn('PostgreSQL schema init failed (non-fatal, continuing):', e.message);
    }
  }

  // ── Redis connection (lazy, non-blocking) ─────────────────────────────────
  if (process.env.SYNC_DISABLED !== 'true') {
    try {
      const { redis } = require('./redisClient');
      await redis.connect().catch(() => {}); // already connected if lazyConnect resolved
    } catch (e) {
      logger.warn('Redis connect failed (non-fatal):', e.message);
    }
  }

  // ── BullMQ worker ─────────────────────────────────────────────────────────
  if (process.env.SYNC_DISABLED !== 'true') {
    try {
      const { startWorker, startReportWorker } = require('./workers/gamSyncWorker');
      startWorker();
      startReportWorker();
    } catch (e) {
      logger.warn('BullMQ worker failed to start (non-fatal):', e.message);
    }
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

  // Pre-warm the most common cache entries in the background so the first
  // real user request is served from cache instead of waiting for GAM.
  if (process.env.GOOGLE_REFRESH_TOKEN && process.env.GAM_NETWORK_CODE) {
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
        const users = await Promise.resolve(getAllUsers());
        const admin = (users || []).find(u => u.role === 'admin');
        if (!admin) return;
        const fullAdmin = await Promise.resolve(getUserById(admin.id));
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
  }
  });
}

startServer().catch(e => {
  logger.error('Server failed to start:', e.message);
  process.exit(1);
});

module.exports = app;
