/**
 * Nightly alert scan. Accounts whose admins are all signed out are picked up the next time an admin
 * opens the alerts list.
 */
const cron = require('node-cron');
const logger = require('../../utils/logger');
const { forEachAccountAdmin } = require('../accounts');
const { scanAccount } = require('./index');

async function scanAllAccounts() {
  let created = 0;
  const stats = await forEachAccountAdmin(async ({ user, accountId, authorization }) => {
    try {
      created += (await scanAccount({ user, authorization })).created;
    } catch (err) {
      logger.warn(`alert scan failed for ${String(accountId).slice(0, 8)}: ${err.message}`);
    }
  });
  logger.info(`alert scan done: ${JSON.stringify({ ...stats, created })}`);
  return { ...stats, created };
}

function startAlertsCron() {
  if (process.env.AI_ALERTS_ENABLED !== 'true') return;
  const expr = process.env.AI_ALERTS_CRON || '0 7 * * *';
  cron.schedule(expr, () => {
    scanAllAccounts().catch((err) => logger.error('alert scan failed:', err.message));
  }, { timezone: process.env.APP_TIMEZONE || 'Asia/Singapore' });
  logger.info(`ai alert scan scheduled (${expr})`);
}

module.exports = { scanAllAccounts, startAlertsCron };
