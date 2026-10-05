/**
 * Alerts: problems found by scanning last week's numbers for every product on an account.
 * Detection is rule-based and free (the same signals the preset analysis uses); no model is called.
 * A problem is raised once, then stays quiet for a week, so the list does not repeat itself daily.
 */
const { query } = require('../../db');
const { getAccountIdForClient } = require('../../models/clientStore');
const { todayInTZ, shiftYMD } = require('../../utils/datetime');
const { cacheGet, cacheSet } = require('../cache');
const { buildFacts } = require('../presetAnalysis');
const { forecastAlerts } = require('../forecast');
const logger = require('../../utils/logger');

const TARGETS = [
  { product: 'gam', kind: 'dashboard' },
  { product: 'gam', kind: 'roi' },
  { product: 'admob', kind: 'dashboard' },
  { product: 'admob', kind: 'roi' },
  { product: 'adsense', kind: 'dashboard' },
  { product: 'adsense', kind: 'roi' },
];

/** Findings worth an alert. Positive news, concentration and "no spend mapped" are not alerts. */
const ALERT_KINDS = new Set([
  'metric_drop', 'price_volume', 'match_rate', 'anomaly', 'drop_off', 'sync_error', 'stale_data',
  'coverage', 'negative_roi', 'losing_entity', 'roi_drop', 'unmatched_spend',
]);
const MAX_PER_SCAN = 10;
const QUIET_DAYS = 7;
const LIST_DAYS = 14;
const SCAN_COOLDOWN_SEC = 6 * 3600;

const inflight = new Map();

const lastScanKey = (accountId) => `ai:alerts:last:${accountId}`;

/** Same problem, different numbers (31% vs 33%) must map to one key. */
function dedupeKey(target, signal) {
  const slug = signal.title.toLowerCase().replace(/[0-9.,%$₹€£]+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${target.product}:${target.kind}:${signal.kind}:${slug}`;
}

async function accountIdFor(user) {
  if (!user?.clientId) return null;
  return (await getAccountIdForClient(user.clientId)) || user.clientId;
}

async function recentlyRaised(accountId, key) {
  const { rows } = await query(
    `SELECT 1 FROM ai_alerts WHERE account_id = $1 AND dedupe_key = $2
       AND created_at > now() - ($3 || ' days')::interval LIMIT 1`,
    [accountId, key, String(QUIET_DAYS)]
  );
  return rows.length > 0;
}

/**
 * Scan every product for the user's account and store new alerts.
 * @returns {Promise<{created: number, scanned: number}>}
 */
async function scanAccount({ user, authorization }) {
  const accountId = await accountIdFor(user);
  if (!accountId) return { created: 0, scanned: 0 };
  if (inflight.has(accountId)) return inflight.get(accountId);

  const run = (async () => {
    const end = shiftYMD(todayInTZ(), -1);
    const start = shiftYMD(end, -6);
    let created = 0;
    let scanned = 0;
    for (const target of TARGETS) {
      if (created >= MAX_PER_SCAN) break;
      let result;
      try {
        result = await buildFacts({
          authorization,
          body: { ...target, startDate: start, endDate: end, filters: {}, depth: 'fast' },
        });
        scanned += 1;
      } catch (err) {
        // A product the account does not use, or one the user cannot read, is simply skipped.
        logger.info(`alert scan skipped ${target.product}/${target.kind}: ${err.message}`);
        continue;
      }
      for (const signal of result.final.signals) {
        if (created >= MAX_PER_SCAN) break;
        if (!['critical', 'warning'].includes(signal.severity) || !ALERT_KINDS.has(signal.kind)) continue;
        const key = dedupeKey(target, signal);
        if (await recentlyRaised(accountId, key)) continue;
        const facts = result.final.book.pick(signal.factIds || []);
        await query(
          `INSERT INTO ai_alerts
             (account_id, product, page_kind, signal_kind, severity, title, body, facts, period_start, period_end, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
          [
            accountId, target.product, target.kind, signal.kind, signal.severity, signal.title, signal.text,
            JSON.stringify(Object.values(facts).map((f) => f.display).slice(0, 4)), start, end, key,
          ]
        );
        created += 1;
      }
    }
    // Months that look likely to miss a target the admin has set (rule-based, from the forecast).
    try {
      const misses = await forecastAlerts({
        authorization,
        ctx: { userId: user.id, clientId: user.clientId || null, role: user.role },
      });
      for (const a of misses) {
        if (created >= MAX_PER_SCAN) break;
        if (await recentlyRaised(accountId, a.key)) continue;
        await query(
          `INSERT INTO ai_alerts
             (account_id, product, page_kind, signal_kind, severity, title, body, facts, period_start, period_end, dedupe_key)
           VALUES ($1,$2,'dashboard','forecast_miss',$3,$4,$5,$6::jsonb,$7,$8,$9)`,
          [accountId, a.product, a.severity, a.title, a.text, JSON.stringify(a.facts), start, end, a.key]
        );
        created += 1;
      }
    } catch (err) {
      logger.info(`forecast alerts skipped: ${err.message}`);
    }
    await cacheSet(lastScanKey(accountId), Date.now(), SCAN_COOLDOWN_SEC);
    logger.info(`alert scan for account ${String(accountId).slice(0, 8)}: ${scanned} sheets, ${created} new alerts`);
    return { created, scanned };
  })().finally(() => inflight.delete(accountId));

  inflight.set(accountId, run);
  return run;
}

async function listAlerts(accountId) {
  const { rows } = await query(
    `SELECT id, product, page_kind, signal_kind, severity, title, body, facts, period_start::text AS period_start,
            period_end::text AS period_end, created_at
     FROM ai_alerts
     WHERE account_id = $1 AND dismissed_at IS NULL AND created_at > now() - ($2 || ' days')::interval
     ORDER BY (severity = 'critical') DESC, created_at DESC
     LIMIT 30`,
    [accountId, String(LIST_DAYS)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    product: r.product,
    page: r.page_kind,
    kind: r.signal_kind,
    severity: r.severity,
    title: r.title,
    text: r.body,
    facts: r.facts || [],
    periodStart: r.period_start,
    periodEnd: r.period_end,
    createdAt: r.created_at,
  }));
}

async function dismissAlert(accountId, id, userId) {
  const { rowCount } = await query(
    `UPDATE ai_alerts SET dismissed_at = now(), dismissed_by = $3
     WHERE id = $1 AND account_id = $2 AND dismissed_at IS NULL`,
    [id, accountId, String(userId)]
  );
  return rowCount > 0;
}

/** True when this account has not been scanned recently (the Alerts screen then starts a scan itself). */
async function isScanDue(accountId) {
  return !(await cacheGet(lastScanKey(accountId))) && !inflight.has(accountId);
}

module.exports = { scanAccount, listAlerts, dismissAlert, isScanDue, accountIdFor, TARGETS };
