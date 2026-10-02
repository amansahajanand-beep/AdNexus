const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { isValidPage, getAll, putPage } = require('../models/presetStore');
const logger = require('../utils/logger');

const router = express.Router();
router.use(requireAuth);

/** All of the signed-in user's saved presets, keyed by page. */
router.get('/', async (req, res) => {
  try {
    const pages = await getAll(req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ pages });
  } catch (err) {
    logger.error('presets list:', err.message);
    res.status(500).json({ error: 'Could not load presets' });
  }
});

/**
 * Replace one page's presets. Body: { items, baseVersion }.
 * 409 returns the server copy when another device saved first.
 */
router.put('/:page', async (req, res) => {
  const { page } = req.params;
  if (!isValidPage(page)) return res.status(400).json({ error: 'Unknown preset page' });
  if (!Array.isArray(req.body?.items)) return res.status(400).json({ error: 'items must be an array' });
  try {
    const result = await putPage(req.user.id, page, req.body.items, req.body.baseVersion);
    if (!result.ok) return res.status(409).json({ error: 'Presets changed elsewhere', ...result.conflict });
    return res.json({ version: result.version, items: result.items });
  } catch (err) {
    logger.error('presets save:', err.message);
    return res.status(500).json({ error: 'Could not save presets' });
  }
});

module.exports = router;
