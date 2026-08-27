const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getRoiSummary } = require('../services/roiService');
const { todayInTZ } = require('../utils/datetime');
const logger = require('../utils/logger');

router.use(requireAuth);

router.get('/summary', async (req, res) => {
  try {
    const clientId = req.client?.id || req.user.clientId;
    if (!clientId) return res.status(400).json({ error: 'No client context' });

    const end = req.query.end || todayInTZ();
    const start = req.query.start || end;
    const targetType = ['site', 'app', 'all'].includes(req.query.targetType)
      ? req.query.targetType
      : 'all';

    const data = await getRoiSummary(clientId, { start, end, targetType });
    res.json({ start, end, targetType, ...data });
  } catch (err) {
    logger.error('ROI summary:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
