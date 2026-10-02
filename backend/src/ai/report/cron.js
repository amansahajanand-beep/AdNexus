/** Weekly executive report, generated for every account whose admin is signed in. */
const cron = require('node-cron');
const logger = require('../../utils/logger');
const { forEachAccountAdmin } = require('../accounts');
const { generateWeeklyReport } = require('./index');

async function generateAllReports() {
  let made = 0;
  const stats = await forEachAccountAdmin(async ({ user, accountId, authorization }) => {
    try {
      await generateWeeklyReport({
        user, accountId, authorization, ctx: { userId: user.id, clientId: user.clientId || null },
      });
      made += 1;
    } catch (err) {
      logger.warn(`weekly report failed for ${String(accountId).slice(0, 8)}: ${err.message}`);
    }
  });
  logger.info(`weekly reports done: ${JSON.stringify({ ...stats, made })}`);
  return { ...stats, made };
}

function startReportCron() {
  if (process.env.AI_REPORT_ENABLED !== 'true') return;
  const expr = process.env.AI_REPORT_CRON || '0 8 * * 1';
  cron.schedule(expr, () => {
    generateAllReports().catch((err) => logger.error('weekly reports failed:', err.message));
  }, { timezone: process.env.APP_TIMEZONE || 'Asia/Singapore' });
  logger.info(`ai weekly report scheduled (${expr})`);
}

module.exports = { generateAllReports, startReportCron };
