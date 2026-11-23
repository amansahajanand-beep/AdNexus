/**
 * Google Sheets export — each signed-in user connects their own spreadsheet.
 * Mounted at /api/sheets.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const store = require('../models/sheetExportStore');
const {
  getServiceAccountEmail, parseSpreadsheetId, verifyAccess, runConnection,
} = require('../services/sheetsExportService');
const { todayInTZ, shiftYMD } = require('../utils/datetime');
const logger = require('../utils/logger');

const router = express.Router();
router.use(requireAuth);

const running = new Set(); // user ids with an export in flight

function publicConnection(c) {
  if (!c) return null;
  return {
    spreadsheetId: c.spreadsheet_id,
    spreadsheetTitle: c.spreadsheet_title,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${c.spreadsheet_id}/edit`,
    enabled: c.enabled,
    lastRunAt: c.last_run_at,
    lastStatus: c.last_status,
    lastError: c.last_error,
    lastResult: c.last_result,
  };
}

router.get('/status', async (req, res) => {
  try {
    const serviceAccountEmail = getServiceAccountEmail();
    res.set('Cache-Control', 'no-store');
    res.json({
      configured: !!serviceAccountEmail,
      serviceAccountEmail,
      connection: publicConnection(await store.getConnection(req.user.id)),
    });
  } catch (err) {
    logger.error('sheets status:', err.message);
    res.status(500).json({ error: 'Could not load Google Sheets settings' });
  }
});

/** Body: { spreadsheet } — a Google Sheets URL or id. Verifies access, then saves + enables. */
router.put('/connection', async (req, res) => {
  const spreadsheetId = parseSpreadsheetId(req.body?.spreadsheet);
  if (!spreadsheetId) return res.status(400).json({ error: 'Paste a valid Google Sheets link' });
  if (!getServiceAccountEmail()) {
    return res.status(503).json({ error: 'Google Sheets export is not configured on the server' });
  }
  try {
    const title = await verifyAccess(spreadsheetId);
    const saved = await store.saveConnection({
      userId: req.user.id, clientId: req.client.id, spreadsheetId, spreadsheetTitle: title,
    });
    res.json({ connection: publicConnection(saved) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** Body: { enabled } — pause / resume the daily push. */
router.patch('/connection', async (req, res) => {
  const saved = await store.setEnabled(req.user.id, req.body?.enabled !== false).catch(() => null);
  if (!saved) return res.status(404).json({ error: 'No sheet connected' });
  res.json({ connection: publicConnection(saved) });
});

router.delete('/connection', async (req, res) => {
  try {
    await store.removeConnection(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error('sheets disconnect:', err.message);
    res.status(500).json({ error: 'Could not disconnect' });
  }
});

/** Body: { days } (1–90, default 7) — export the last N days through yesterday right now. */
router.post('/run', async (req, res) => {
  const conn = await store.getConnection(req.user.id).catch(() => null);
  if (!conn) return res.status(404).json({ error: 'No sheet connected' });
  if (running.has(req.user.id)) return res.status(409).json({ error: 'An export is already running' });
  const days = Math.min(90, Math.max(1, parseInt(req.body?.days, 10) || 7));
  const endDate = shiftYMD(todayInTZ(), -1);
  running.add(req.user.id);
  try {
    const out = await runConnection(conn, { startDate: shiftYMD(endDate, -(days - 1)), endDate });
    const fresh = await store.getConnection(req.user.id);
    res.status(out.ok ? 200 : 502).json({ ok: out.ok, error: out.error, connection: publicConnection(fresh) });
  } finally {
    running.delete(req.user.id);
  }
});

module.exports = router;
