/** Avoid circular imports between store.js and authActions.js */
let persistorInstance = null;

export function registerPersistor(p) {
  persistorInstance = p;
}

export function purgePersistedState() {
  return persistorInstance?.purge();
}
