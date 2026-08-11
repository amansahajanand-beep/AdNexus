const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function runWithClient(client, fn) {
  return als.run({ client: client || null }, fn);
}

function getClient() {
  return als.getStore()?.client || null;
}

function getClientId() {
  return getClient()?.id || null;
}

function requireClientId() {
  const id = getClientId();
  if (!id) throw new Error('Missing client context');
  return id;
}

function isMockClient(client = getClient()) {
  if (client) return !client.refreshToken || !client.networkCode || client.isActive === false;
  return true;
}

function tenantKey(key) {
  const id = getClientId() || 'none';
  return `c:${id}:${key}`;
}

module.exports = {
  runWithClient,
  getClient,
  getClientId,
  requireClientId,
  isMockClient,
  tenantKey,
};
