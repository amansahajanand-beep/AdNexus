const crypto = require('crypto');
const { query } = require('../db');
const { encryptSecret, decryptSecret } = require('../utils/credentialsCrypto');
const logger = require('../utils/logger');

function slugify(name) {
  const base = String(name || 'client')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'client';
  return base;
}

function isPendingNetworkCode(networkCode) {
  return String(networkCode || '').trim().toLowerCase().startsWith('pending-');
}

function mapPublic(row) {
  if (!row) return null;
  const networkCode = row.network_code;
  const pending = isPendingNetworkCode(networkCode) || !row.google_refresh_token_enc;
  return {
    id: row.id,
    accountId: row.account_id || row.id,
    name: row.name,
    slug: row.slug,
    networkCode: pending && isPendingNetworkCode(networkCode) ? null : networkCode,
    rawNetworkCode: networkCode,
    googleClientId: row.google_client_id,
    redirectUri: row.redirect_uri || null,
    isActive: row.is_active !== false,
    isPending: pending,
    hasRefreshToken: !!row.google_refresh_token_enc,
    hasClientSecret: !!row.google_client_secret_enc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntime(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id || row.id,
    name: row.name,
    slug: row.slug,
    networkCode: row.network_code,
    googleClientId: row.google_client_id,
    googleClientSecret: row.google_client_secret_enc ? decryptSecret(row.google_client_secret_enc) : null,
    refreshToken: row.google_refresh_token_enc ? decryptSecret(row.google_refresh_token_enc) : null,
    redirectUri: row.redirect_uri || process.env.GOOGLE_REDIRECT_URI || null,
    isActive: row.is_active !== false,
    isPending: isPendingNetworkCode(row.network_code) || !row.google_refresh_token_enc,
  };
}

async function getClientById(id) {
  if (!id) return null;
  const { rows } = await query('SELECT * FROM gam_clients WHERE id = $1', [id]);
  return rows[0] ? mapRuntime(rows[0]) : null;
}

async function getClientPublicById(id) {
  if (!id) return null;
  const { rows } = await query('SELECT * FROM gam_clients WHERE id = $1', [id]);
  return rows[0] ? mapPublic(rows[0]) : null;
}

async function getClientByNetworkCode(networkCode) {
  const { rows } = await query('SELECT * FROM gam_clients WHERE network_code = $1', [networkCode]);
  return rows[0] ? mapRuntime(rows[0]) : null;
}

/** Row lookup without decrypt — needed so SYNC can overwrite even if old ciphertext is unreadable. */
async function findClientRowByNetworkCode(networkCode) {
  const { rows } = await query(
    'SELECT id, name, network_code, account_id FROM gam_clients WHERE network_code = $1',
    [String(networkCode).trim()]
  );
  return rows[0] || null;
}

function envFlagTrue(name) {
  const raw = String(process.env[name] || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

async function listActiveClients() {
  const { rows } = await query(
    `SELECT * FROM gam_clients
     WHERE is_active = true
       AND google_refresh_token_enc IS NOT NULL
       AND network_code NOT ILIKE 'pending-%'
     ORDER BY created_at ASC`
  );
  const out = [];
  for (const row of rows) {
    try {
      out.push(mapRuntime(row));
    } catch (e) {
      logger.warn(
        `[tenancy] Skipping gam_clients ${row.id} (decrypt failed: ${e.message}). `
        + 'Set SYNC_GAM_CREDS_FROM_ENV=true and restart to overwrite secrets from env.'
      );
    }
  }
  return out;
}

async function listAllClientsPublic() {
  const { rows } = await query('SELECT * FROM gam_clients ORDER BY created_at ASC');
  return rows.map(mapPublic);
}

/** All network rows under the same account (for Admin switcher). */
async function listClientsByAccountId(accountId) {
  if (!accountId) return [];
  const { rows } = await query(
    `SELECT * FROM gam_clients
     WHERE account_id = $1::uuid OR id = $1::uuid
     ORDER BY
       CASE WHEN network_code ILIKE 'pending-%' THEN 1 ELSE 0 END,
       created_at ASC`,
    [accountId]
  );
  return rows.map(mapPublic);
}

async function getAccountIdForClient(clientId) {
  if (!clientId) return null;
  const { rows } = await query(
    'SELECT COALESCE(account_id, id) AS account_id FROM gam_clients WHERE id = $1::uuid',
    [clientId]
  );
  return rows[0]?.account_id || null;
}

async function createClient({
  id: providedId = null,
  name,
  networkCode,
  googleClientId,
  googleClientSecret,
  refreshToken,
  redirectUri,
  isActive = true,
  accountId = null,
}) {
  const id = providedId || crypto.randomUUID();
  let slug = slugify(name);
  const existingSlug = await query('SELECT 1 FROM gam_clients WHERE slug = $1', [slug]);
  if (existingSlug.rowCount) slug = `${slug}-${id.slice(0, 8)}`;

  const resolvedAccountId = accountId || id;

  await query(
    `INSERT INTO gam_clients (
       id, account_id, name, slug, network_code, google_client_id,
       google_client_secret_enc, google_refresh_token_enc, redirect_uri, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      resolvedAccountId,
      String(name).trim(),
      slug,
      String(networkCode).trim(),
      String(googleClientId || 'pending').trim(),
      encryptSecret(googleClientSecret || 'pending'),
      refreshToken ? encryptSecret(refreshToken) : null,
      redirectUri || null,
      isActive !== false,
    ]
  );
  return getClientById(id);
}

/**
 * Register (2A): publisher row with no GAM network yet.
 * Uses a unique pending-* network_code until Connect with Google upgrades it.
 */
async function createPlaceholderClient({ name }) {
  const id = crypto.randomUUID();
  const pendingCode = `pending-${id.replace(/-/g, '').slice(0, 16)}`;
  const envId = String(process.env.GOOGLE_CLIENT_ID || '').trim() || 'pending';
  const envSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim() || 'pending';
  return createClient({
    id,
    name: String(name || 'Publisher').trim(),
    networkCode: pendingCode,
    googleClientId: envId,
    googleClientSecret: envSecret,
    refreshToken: null,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || null,
    accountId: id,
  });
}

async function updateClientCredentials(id, {
  name,
  networkCode,
  googleClientId,
  googleClientSecret,
  refreshToken,
  redirectUri,
  isActive,
  accountId,
}) {
  const fields = ['updated_at = NOW()'];
  const params = [];
  let i = 1;
  const add = (col, val) => {
    fields.push(`${col} = $${i++}`);
    params.push(val);
  };
  if (name != null) add('name', String(name).trim());
  if (networkCode != null) add('network_code', String(networkCode).trim());
  if (googleClientId != null) add('google_client_id', String(googleClientId).trim());
  if (googleClientSecret) add('google_client_secret_enc', encryptSecret(googleClientSecret));
  if (refreshToken) add('google_refresh_token_enc', encryptSecret(refreshToken));
  if (redirectUri !== undefined) add('redirect_uri', redirectUri || null);
  if (typeof isActive === 'boolean') add('is_active', isActive);
  if (accountId != null) add('account_id', accountId);
  params.push(id);
  await query(`UPDATE gam_clients SET ${fields.join(', ')} WHERE id = $${i}`, params);
  return getClientById(id);
}

/** True when a runtime client has credentials needed for GAM API calls. */
function isUsableGamClient(client) {
  return !!(
    client
    && client.isActive !== false
    && String(client.networkCode || '').trim()
    && !isPendingNetworkCode(client.networkCode)
    && String(client.googleClientId || '').trim()
    && client.googleClientId !== 'pending'
    && String(client.googleClientSecret || '').trim()
    && client.googleClientSecret !== 'pending'
    && String(client.refreshToken || '').trim()
  );
}

/**
 * Resolve the GAM client for a portal user.
 * Returns the linked row even when pending (so Admin can Connect with Google).
 * Child users stay locked to their users.client_id (1B).
 */
async function resolveClientForUser(user) {
  let client = null;
  try {
    if (user?.clientId) client = await getClientById(user.clientId);
  } catch (e) {
    logger.warn(
      `[tenancy] Could not load gam_clients for user=${user?.username || user?.id}: ${e.message}`
    );
    client = null;
  }
  if (client) return client;

  try {
    client = await ensureBootstrapFromEnv();
  } catch (e) {
    logger.warn(`[tenancy] Bootstrap fallback failed: ${e.message}`);
    client = null;
  }
  return client || null;
}

async function ensureBootstrapFromEnv() {
  const networkCode = process.env.GAM_NETWORK_CODE;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const syncFromEnv = envFlagTrue('SYNC_GAM_CREDS_FROM_ENV');
  const present = {
    GAM_NETWORK_CODE: !!String(networkCode || '').trim(),
    GOOGLE_CLIENT_ID: !!String(clientId || '').trim(),
    GOOGLE_CLIENT_SECRET: !!String(clientSecret || '').trim(),
    GOOGLE_REFRESH_TOKEN: !!String(refreshToken || '').trim(),
    SYNC_GAM_CREDS_FROM_ENV: syncFromEnv,
  };

  if (!networkCode || !clientId || !clientSecret || !refreshToken) {
    logger.warn(
      `[tenancy] Bootstrap skipped — incomplete env credentials: ${JSON.stringify(present)}`
    );
    return null;
  }

  // Prefer raw row lookup so a bad/old encryption key cannot block overwrite.
  let existingRow = await findClientRowByNetworkCode(networkCode);

  // Single-tenant production: env network_code may not match the only DB row.
  if (!existingRow && syncFromEnv) {
    const { rows } = await query(
      'SELECT id, name, network_code FROM gam_clients ORDER BY created_at ASC LIMIT 2'
    );
    if (rows.length === 1) {
      existingRow = rows[0];
      logger.warn(
        `[tenancy] SYNC: no gam_clients row for network ${String(networkCode).trim()}; `
        + `updating sole client "${existingRow.name}" (${existingRow.network_code} → ${String(networkCode).trim()}).`
      );
    } else if (rows.length > 1) {
      logger.warn(
        `[tenancy] SYNC: no gam_clients row for network ${String(networkCode).trim()} and `
        + `${rows.length}+ clients exist — not guessing. Update Admin → Client settings, or align GAM_NETWORK_CODE.`
      );
    }
  }

  if (existingRow) {
    // Production: live requests use gam_clients (encrypted), not .env.
    // Set SYNC_GAM_CREDS_FROM_ENV=true once after rotating Google OAuth secrets, then restart.
    if (syncFromEnv) {
      const updated = await updateClientCredentials(existingRow.id, {
        networkCode,
        googleClientId: clientId,
        googleClientSecret: clientSecret,
        refreshToken,
        redirectUri: process.env.GOOGLE_REDIRECT_URI || null,
      });
      logger.warn(
        `[tenancy] Synced GAM OAuth credentials from .env → gam_clients (${updated.name}). `
        + 'Unset SYNC_GAM_CREDS_FROM_ENV after a successful login.'
      );
      return updated;
    }
    try {
      return await getClientById(existingRow.id);
    } catch (e) {
      logger.warn(
        `[tenancy] Could not decrypt gam_clients secrets for ${existingRow.id}: ${e.message}. `
        + 'Set SYNC_GAM_CREDS_FROM_ENV=true and restart to overwrite from env.'
      );
      return null;
    }
  }

  const created = await createClient({
    name: process.env.BOOTSTRAP_CLIENT_NAME || 'Default publisher',
    networkCode,
    googleClientId: clientId,
    googleClientSecret: clientSecret,
    refreshToken,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || null,
  });
  logger.info(`[tenancy] Bootstrapped Client #1 from .env (network ${networkCode}) id=${created.id}`);
  return created;
}

module.exports = {
  mapPublic,
  getClientById,
  getClientPublicById,
  getClientByNetworkCode,
  listActiveClients,
  listAllClientsPublic,
  listClientsByAccountId,
  getAccountIdForClient,
  createClient,
  createPlaceholderClient,
  updateClientCredentials,
  ensureBootstrapFromEnv,
  isUsableGamClient,
  isPendingNetworkCode,
  resolveClientForUser,
};
