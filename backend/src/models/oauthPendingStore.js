/**
 * Short-lived OAuth sessions: hold refresh tokens between Google callback and account/network picker.
 */
const crypto = require('crypto');
const { query, schemaQuery } = require('../db');
const { encryptSecret, decryptSecret } = require('../utils/credentialsCrypto');

const TTL_MINUTES = 30;

async function ensureTable() {
  await schemaQuery(`
    CREATE TABLE IF NOT EXISTS oauth_pending_sessions (
      id UUID PRIMARY KEY,
      product TEXT NOT NULL CHECK (product IN ('ads', 'gam')),
      mode TEXT NOT NULL DEFAULT 'connect',
      client_id UUID REFERENCES gam_clients(id) ON DELETE CASCADE,
      refresh_token_enc TEXT,
      candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      payload_json JSONB,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await schemaQuery(`
    CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires
      ON oauth_pending_sessions (expires_at)
  `);
}

let tableReady = null;
function ready() {
  if (!tableReady) tableReady = ensureTable().catch((err) => {
    tableReady = null;
    throw err;
  });
  return tableReady;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    product: row.product,
    mode: row.mode,
    clientId: row.client_id || null,
    refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
    candidates: Array.isArray(row.candidates_json) ? row.candidates_json : (row.candidates_json || []),
    payload: row.payload_json || null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

async function createPendingSession({
  product,
  mode = 'connect',
  clientId = null,
  refreshToken = null,
  candidates = [],
  payload = null,
}) {
  await ready();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);
  await query(
    `INSERT INTO oauth_pending_sessions (
       id, product, mode, client_id, refresh_token_enc, candidates_json, payload_json, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      id,
      product,
      mode,
      clientId || null,
      refreshToken ? encryptSecret(refreshToken) : null,
      JSON.stringify(candidates || []),
      payload != null ? JSON.stringify(payload) : null,
      expiresAt.toISOString(),
    ]
  );
  return getPendingSession(id);
}

async function getPendingSession(id) {
  if (!id) return null;
  await ready();
  await query(`DELETE FROM oauth_pending_sessions WHERE expires_at < now()`);
  const { rows } = await query(
    `SELECT * FROM oauth_pending_sessions WHERE id = $1 AND expires_at >= now()`,
    [id]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Public view — never includes refresh token. */
async function getPendingSessionPublic(id) {
  const session = await getPendingSession(id);
  if (!session) return null;
  return {
    id: session.id,
    product: session.product,
    mode: session.mode,
    clientId: session.clientId,
    candidates: session.candidates,
    expiresAt: session.expiresAt,
    payload: session.payload
      ? {
          name: session.payload.name || null,
          username: session.payload.username || null,
          email: session.payload.email || null,
        }
      : null,
  };
}

async function deletePendingSession(id) {
  if (!id) return;
  await ready();
  await query(`DELETE FROM oauth_pending_sessions WHERE id = $1`, [id]);
}

module.exports = {
  ensureTable,
  createPendingSession,
  getPendingSession,
  getPendingSessionPublic,
  deletePendingSession,
  TTL_MINUTES,
};
