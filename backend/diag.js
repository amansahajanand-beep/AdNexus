require('dotenv').config();
const axios = require('axios');
const { getGAMClient } = require('./src/gamClient');

const API_VER = 'v202602';
const NETWORK_CODE = process.env.GAM_NETWORK_CODE;

function envelope(service, method, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dfp="https://www.google.com/apis/ads/publisher/${API_VER}">
  <soapenv:Header>
    <dfp:RequestHeader>
      <dfp:networkCode>${NETWORK_CODE}</dfp:networkCode>
      <dfp:applicationName>GAM-Dashboard</dfp:applicationName>
    </dfp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body><${method} xmlns="https://www.google.com/apis/ads/publisher/${API_VER}">${body}</${method}></soapenv:Body>
</soapenv:Envelope>`;
}

async function call(service, method, body, token) {
  console.log(`\n=== ${service}.${method} ===`);
  try {
    const res = await axios.post(
      `https://ads.google.com/apis/ads/publisher/${API_VER}/${service}`,
      envelope(service, method, body),
      { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'Authorization': `Bearer ${token}`, 'SOAPAction': '' } }
    );
    console.log('HTTP', res.status);
    console.log(String(res.data).slice(0, 1500));
  } catch (e) {
    console.log('HTTP status:', e.response?.status, '| message:', e.message);
    console.log('BODY:\n', String(e.response?.data || '').slice(0, 2500));
  }
}

(async () => {
  const auth = await getGAMClient();
  const token = (await auth.getAccessToken()).token;

  // Orders (filter clause only, no SELECT/FROM); inner tags unprefixed (default ns)
  await call('OrderService', 'getOrdersByStatement',
    `<filterStatement><query>ORDER BY name LIMIT 5</query></filterStatement>`, token);

  // Inventory
  await call('InventoryService', 'getAdUnitsByStatement',
    `<filterStatement><query>WHERE status = 'ACTIVE' LIMIT 5</query></filterStatement>`, token);

  // Report
  await call('ReportService', 'runReportJob',
    `<reportJob><reportQuery><dimensions>DATE</dimensions><columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns><dateRangeType>LAST_WEEK</dateRangeType></reportQuery></reportJob>`, token);
})();
