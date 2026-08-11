const express = require('express');
const router = express.Router();
const { cache } = require('../gamClient');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { hasFlag } = require('../utils/permissions');

const { isMockClient, getClient } = require('../utils/clientContext');

router.use(requireAuth);

function mockOrders(page = 1, limit = 10, search = '', status = '') {
  const all = [
    { id: '1001', name: 'Diwali Sale 2025', advertiserName: 'Flipkart', status: 'DELIVERING', startDate: '2025-09-01', endDate: '2025-11-30', totalBudget: '12400000000', externalId: 'FLK-2025-01' },
    { id: '1002', name: 'Video Masthead Q4', advertiserName: 'Amazon India', status: 'DELIVERING', startDate: '2025-10-01', endDate: '2025-12-31', totalBudget: '10100000000', externalId: 'AMZ-2025-04' },
    { id: '1003', name: 'Home Loan Awareness', advertiserName: 'HDFC Bank', status: 'PAUSED', startDate: '2025-08-15', endDate: '2025-12-15', totalBudget: '7800000000', externalId: 'HDFC-2025-07' },
    { id: '1004', name: 'Food Delivery Push', advertiserName: 'Swiggy', status: 'DELIVERING', startDate: '2025-10-10', endDate: '2025-12-10', totalBudget: '5200000000', externalId: 'SWG-2025-10' },
    { id: '1005', name: 'EdTech Awareness', advertiserName: "Byju's", status: 'DELIVERING', startDate: '2025-09-01', endDate: '2026-01-31', totalBudget: '4600000000', externalId: 'BYJ-2025-09' },
    { id: '1006', name: 'Travel Season Campaign', advertiserName: 'MakeMyTrip', status: 'COMPLETED', startDate: '2025-06-01', endDate: '2025-09-30', totalBudget: '3900000000', externalId: 'MMT-2025-06' },
    { id: '1007', name: 'Mobile Launch – Nord 4', advertiserName: 'OnePlus India', status: 'DELIVERING', startDate: '2025-11-01', endDate: '2026-01-31', totalBudget: '3500000000', externalId: 'OPL-2025-11' },
    { id: '1008', name: 'Insurance Awareness Q4', advertiserName: 'LIC', status: 'PAUSED', startDate: '2025-10-01', endDate: '2025-12-31', totalBudget: '2800000000', externalId: 'LIC-2025-10' },
    { id: '1009', name: 'Year End Sale', advertiserName: 'Myntra', status: 'READY', startDate: '2025-12-01', endDate: '2025-12-31', totalBudget: '6200000000', externalId: 'MYN-2025-12' },
    { id: '1010', name: 'App Install Campaign', advertiserName: 'PhonePe', status: 'DELIVERING', startDate: '2025-10-15', endDate: '2026-02-15', totalBudget: '4100000000', externalId: 'PPE-2025-10' },
    { id: '1011', name: 'Credit Card Launch', advertiserName: 'ICICI Bank', status: 'DRAFT', startDate: '2025-12-15', endDate: '2026-03-15', totalBudget: '5500000000', externalId: 'ICICI-2025-12' },
    { id: '1012', name: 'Grocery Delivery Push', advertiserName: 'BigBasket', status: 'DELIVERING', startDate: '2025-11-01', endDate: '2026-01-31', totalBudget: '3200000000', externalId: 'BB-2025-11' },
  ];

  let filtered = all;
  if (search) filtered = filtered.filter(o =>
    o.name.toLowerCase().includes(search.toLowerCase()) ||
    o.advertiserName.toLowerCase().includes(search.toLowerCase())
  );
  if (status) filtered = filtered.filter(o => o.status === status);

  const total = filtered.length;
  const offset = (page - 1) * limit;
  return {
    orders: filtered.slice(offset, offset + limit),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  };
}

// GET /api/orders
router.get('/', async (req, res) => {
  if (!hasFlag(req.user, 'canSeeOrders')) {
    return res.status(403).json({ error: 'You do not have permission to view orders.' });
  }
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const status = req.query.status || '';

  if (isMockClient()) {
    logger.info('Mock mode: returning mock orders');
    return res.json(mockOrders(page, limit, search, status));
  }

  const cacheKey = `orders_${page}_${limit}_${status}_${search}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { getGAMClient } = require('../gamClient');
    const auth = await getGAMClient();
    const tokenObj = await auth.getAccessToken();
    const token = tokenObj.token;
    const axios = require('axios');
    const { GAM_API_VERSION: API_VER } = require('../utils/gamVersion');
    const NETWORK_CODE = getClient()?.networkCode || process.env.GAM_NETWORK_CODE;
    const offset = (page - 1) * limit;

    // PQL filter statement: only the clause (no SELECT/FROM) is allowed for getXxxByStatement
    const conds = [];
    if (status) conds.push(`status = '${status}'`);
    if (search) conds.push(`name LIKE '%${search}%'`);
    const whereClause = conds.length ? `WHERE ${conds.join(' AND ')} ` : '';

    const envelope = (method, body) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${API_VER}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${NETWORK_CODE}</dfp:networkCode>
      <dfp:applicationName>AdNexus</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body><${method} xmlns="https://www.google.com/apis/ads/publisher/${API_VER}">${body}</${method}></soapenv:Body>
</soapenv:Envelope>`;

    const xml = await axios.post(
      `https://ads.google.com/apis/ads/publisher/${API_VER}/OrderService`,
      envelope('getOrdersByStatement', `<filterStatement><query>${whereClause}ORDER BY name LIMIT ${limit} OFFSET ${offset}</query></filterStatement>`),
      { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'Authorization': `Bearer ${token}`, 'SOAPAction': '' } }
    );

    const data = xml.data;
    // Extracts YYYY-MM-DD from a named datetime block like <startDateTime><date><year>..</year>..
    const extractDate = (block, tag) => {
      const seg = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`));
      if (!seg) return null;
      const y = seg[1].match(/<year>(\d+)<\/year>/);
      const mo = seg[1].match(/<month>(\d+)<\/month>/);
      const d = seg[1].match(/<day>(\d+)<\/day>/);
      if (!y) return null;
      return `${y[1]}-${String(mo ? mo[1] : 1).padStart(2, '0')}-${String(d ? d[1] : 1).padStart(2, '0')}`;
    };
    const results = [];
    const matches = data.matchAll(/<results[^>]*>([\s\S]*?)<\/results>/g);
    for (const m of matches) {
      const b = m[1];
      const extract = tag => { const r = b.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`)); return r ? r[1].trim() : null; };
      const budgetSeg = b.match(/<totalBudget>([\s\S]*?)<\/totalBudget>/);
      const budgetMicro = budgetSeg ? (budgetSeg[1].match(/<microAmount>(\d+)<\/microAmount>/) || [])[1] : null;
      results.push({
        id: extract('id'), name: extract('name'), status: extract('status'),
        advertiserName: extract('advertiserId'),
        startDate: extractDate(b, 'startDateTime'),
        endDate: extractDate(b, 'endDateTime'),
        totalBudget: budgetMicro || null,
        externalId: extract('externalOrderId')
      });
    }
    const totalMatch = data.match(/<totalResultSetSize>(\d+)<\/totalResultSetSize>/);
    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
    const result = { orders: results, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    cache.set(cacheKey, result, 60);
    res.json(result);
  } catch (err) {
    logger.error('Orders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
