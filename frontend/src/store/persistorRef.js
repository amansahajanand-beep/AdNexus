/** Avoid circular imports between store.js and authActions.js */
let persistorInstance = null;

export function registerPersistor(p) {
  persistorInstance = p;
}

export function purgePersistedState() {
  return persistorInstance?.purge();
}

/** Wait until redux-persist has written the latest state (e.g. cleared reports). */
export function flushPersistedState() {
  return persistorInstance?.flush?.() || Promise.resolve();
}
