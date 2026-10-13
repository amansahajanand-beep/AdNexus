/**
 * Report activity gate: background backfills (fill rate, ad requests) wait while people are
 * using Reporting / Dashboard, so they never compete with a report for the database disk.
 *
 * - reportActivity middleware marks a request active until it finishes and records the time.
 * - waitForQuiet() resolves once no report is running and none finished in the last quietMs
 *   (or after maxWaitMs, so a backfill is only delayed, never starved forever).
 */
let active = 0;
let lastActivityAt = 0;

function reportActivity(req, res, next) {
  active += 1;
  lastActivityAt = Date.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    active = Math.max(0, active - 1);
    lastActivityAt = Date.now();
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

function isQuiet(quietMs) {
  return active === 0 && Date.now() - lastActivityAt >= quietMs;
}

async function waitForQuiet({
  quietMs = 20000,
  // Busy hours: wait for a gap, but never longer than this per step, or a 180-day backfill
  // would take ~30 h. Raise BACKFILL_MAX_WAIT_MS to be gentler on reports.
  maxWaitMs = parseInt(process.env.BACKFILL_MAX_WAIT_MS || '60000', 10) || 60000,
  pollMs = 2000,
} = {}) {
  const start = Date.now();
  while (!isQuiet(quietMs) && Date.now() - start < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

module.exports = { reportActivity, waitForQuiet, isQuiet };
