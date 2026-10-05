/**
 * Daily earnings for the forecast: the last ~3 months, complete days only (the model drops today).
 * Google Ad Manager reads the warehouse's inventory rollup for the admin's own network (fast, and not tied to
 * the Dashboard's live Ad Manager path); AdMob and AdSense read their own /trend endpoints as the signed-in user.
 */
const { schemaQuery } = require('../../db');
const { callRouter } = require('../internalCall');
const { shiftYMD } = require('../../utils/datetime');
const { monthBounds, addDays } = require('./model');

const HISTORY_DAYS = 84;

const ROUTERS = {
  admob: () => require('../../routes/admob'),
  adsense: () => require('../../routes/adsense'),
};

class ForecastDataError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** First day to load: far enough back to cover all of last month, and at least 12 weeks. */
function historyStart(today) {
  const prevMonthStart = monthBounds(addDays(`${today.slice(0, 8)}01`, -1)).start;
  const twelveWeeks = shiftYMD(today, -HISTORY_DAYS);
  return prevMonthStart < twelveWeeks ? prevMonthStart : twelveWeeks;
}

async function gamSeries({ ctx, start, end }) {
  if (ctx?.role !== 'admin' || !ctx?.clientId) throw new ForecastDataError(403, 'The forecast is available to admins.');
  const { rows } = await schemaQuery(
    `SELECT report_date::text AS date, COALESCE(SUM(revenue), 0)::float8 AS value
     FROM rollup_inventory_kpi_daily
     WHERE client_id = $1::uuid AND report_date >= $2::date AND report_date <= $3::date
     GROUP BY report_date
     ORDER BY report_date`,
    [ctx.clientId, start, end]
  );
  return { series: rows, currency: 'USD', source: 'Warehouse daily rollup' };
}

async function publisherSeries({ product, authorization, start, end }) {
  let res;
  try {
    res = await callRouter(ROUTERS[product](), { path: '/trend', query: { startDate: start, endDate: end }, authorization, timeoutMs: 30_000 });
  } catch {
    throw new ForecastDataError(504, 'The earnings data took too long to load.');
  }
  if (res.status !== 200) {
    throw new ForecastDataError(res.status === 403 ? 403 : 502, res.status === 403 ? 'This user is not allowed to see that data.' : (res.body?.error || 'Could not load the earnings data.'));
  }
  const rows = Array.isArray(res.body?.trend) ? res.body.trend : [];
  return {
    series: rows.map((r) => ({ date: String(r.date).slice(0, 10), value: Number(r.earnings) || 0 })),
    currency: res.body?.currency || 'USD',
    source: 'Daily earnings synced from Google',
  };
}

/**
 * @param {{product: 'gam'|'admob'|'adsense', today: string, authorization: string, ctx: object}} opts
 * @returns {Promise<{series: {date: string, value: number}[], currency: string, source: string}>}
 */
async function loadDailyEarnings({ product, today, authorization, ctx }) {
  const start = historyStart(today);
  const end = shiftYMD(today, -1);
  if (product === 'gam') return gamSeries({ ctx, start, end });
  return publisherSeries({ product, authorization, start, end });
}

module.exports = { loadDailyEarnings, ForecastDataError, historyStart, HISTORY_DAYS };
