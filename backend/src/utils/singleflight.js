/**
 * Coalesce concurrent identical async work into one promise.
 * Callers with the same key share one in-flight result instead of stampeding PG.
 *
 * Re-enters ALS with the caller’s client so Promise.then cannot drop tenancy
 * (multi-network dashboard fires parallel overviews).
 */
const inflight = new Map();

function singleflight(key, fn) {
  const k = String(key || '');
  if (!k) return Promise.resolve().then(fn);

  const existing = inflight.get(k);
  if (existing) return existing;

  let client = null;
  try {
    client = require('./clientContext').getClient();
  } catch (_) { /* ignore */ }

  const { runWithClient } = require('./clientContext');
  const p = Promise.resolve()
    .then(() => (client ? runWithClient(client, fn) : fn()))
    .finally(() => {
      if (inflight.get(k) === p) inflight.delete(k);
    });
  inflight.set(k, p);
  return p;
}

function inflightCount() {
  return inflight.size;
}

module.exports = { singleflight, inflightCount };
