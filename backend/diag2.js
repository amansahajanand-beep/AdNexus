require('dotenv').config();
const axios = require('axios');
const { getGAMClient } = require('./src/gamClient');

const API_VER = 'v202602';
const NETWORK_CODE = process.env.GAM_NETWORK_CODE;
const BASE = `https://ads.google.com/apis/ads/publisher/${API_VER}`;

function envelope(method, body) {
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

async function soap(method, body, token) {
  const res = await axios.post(`${BASE}/ReportService`, envelope(method, body),
    { headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'Authorization': `Bearer ${token}`, 'SOAPAction': '' } });
  return res.data;
}
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([^<]+)</${t}>`)); return m ? m[1].trim() : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const auth = await getGAMClient();
  const token = (await auth.getAccessToken()).token;

  console.log('1) runReportJob (exact summary query)');
  const now = new Date(); const start = new Date(); start.setDate(start.getDate() - 7);
  const sd = { y: start.getFullYear(), m: start.getMonth() + 1, d: start.getDate() };
  const ed = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  let submit;
  try {
    submit = await soap('runReportJob',
      `<reportJob><reportQuery><dimensions>DATE</dimensions><columns>TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS</columns><columns>TOTAL_LINE_ITEM_LEVEL_CLICKS</columns><columns>TOTAL_LINE_ITEM_LEVEL_CTR</columns><columns>TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE</columns><columns>TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS</columns><startDate><year>${sd.y}</year><month>${sd.m}</month><day>${sd.d}</day></startDate><endDate><year>${ed.y}</year><month>${ed.m}</month><day>${ed.d}</day></endDate><dateRangeType>CUSTOM_DATE</dateRangeType></reportQuery></reportJob>`, token);
  } catch (e) {
    console.log('   runReportJob FAILED:', e.response?.status);
    console.log(String(e.response?.data || '').slice(0, 2500));
    return;
  }
  const jobId = tag(submit, 'id');
  console.log('   jobId:', jobId);

  console.log('2) poll getReportJobStatus');
  let status = '', tries = 0;
  while (tries < 20) {
    await sleep(2000);
    const st = await soap('getReportJobStatus', `<reportJobId>${jobId}</reportJobId>`, token);
    status = tag(st, 'rval');
    console.log('   status:', status);
    if (status === 'COMPLETED' || status === 'FAILED') break;
    tries++;
  }

  if (status !== 'COMPLETED') { console.log('   report not completed, abort'); return; }

  console.log('3) getReportDownloadUrlWithOptions');
  try {
    const dl = await soap('getReportDownloadUrlWithOptions',
      `<reportJobId>${jobId}</reportJobId><reportDownloadOptions><exportFormat>CSV_DUMP</exportFormat><useGzipCompression>false</useGzipCompression></reportDownloadOptions>`, token);
    let url = tag(dl, 'rval');
    if (url) url = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    console.log('   download URL:', url ? url.slice(0, 120) + '...' : '(none)');
    if (url) {
      const csv = await axios.get(url, { responseType: 'text' });
      console.log('   CSV (first 600 chars):\n', String(csv.data).slice(0, 600));
    }
  } catch (e) {
    console.log('   download error:', e.response?.status, e.message);
    console.log(String(e.response?.data || '').slice(0, 1500));
  }
})();
