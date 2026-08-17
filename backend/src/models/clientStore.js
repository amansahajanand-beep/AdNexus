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

function mapPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    networkCode: row.network_code,
    googleClientId: row.google_client_id,
    redirectUri: row.redirect_uri || null,
    isActive: row.is_active !== false,
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
    name: row.name,
    slug: row.slug,
    networkCode: row.network_code,
    googleClientId: row.google_client_id,
    googleClientSecret: row.google_client_secret_enc ? decryptSecret(row.google_client_secret_enc) : null,
    refreshToken: row.google_refresh_token_enc ? decryptSecret(row.google_refresh_token_enc) : null,
    redirectUri: row.redirect_uri || process.env.GOOGLE_REDIRECT_URI || null,
    isActive: row.is_active !== false,
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

async function listActiveClients() {
  const { rows } = await query(
    `SELECT * FROM gam_clients WHERE is_active = true AND google_refresh_token_enc IS NOT NULL
     ORDER BY created_at ASC`
  );
  return rows.map(mapRuntime);
}

async function listAllClientsPublic() {
  const { rows } = await query('SELECT * FROM gam_clients ORDER BY created_at ASC');
  return rows.map(mapPublic);
}

async function createClient({
  name,
  networkCode,
  googleClientId,
  googleClientSecret,
  refreshToken,
  redirectUri,
  isActive = true,
}) {
  const id = crypto.randomUUID();
  let slug = slugify(name);
  const existingSlug = await query('SELECT 1 FROM gam_clients WHERE slug = $1', [slug]);
  if (existingSlug.rowCount) slug = `${slug}-${id.slice(0, 8)}`;

  await query(
    `INSERT INTO gam_clients (
       id, name, slug, network_code, google_client_id,
       google_client_secret_enc, google_refresh_token_enc, redirect_uri, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      String(name).trim(),
      slug,
      String(networkCode).trim(),
      String(googleClientId).trim(),
      encryptSecret(googleClientSecret),
      encryptSecret(refreshToken),
      redirectUri || null,
      isActive !== false,
    ]
  );
  return getClientById(id);
}

async function updateClientCredentials(id, {
  name,
  networkCode,
  googleClientId,
  googleClientSecret,
  refreshToken,
  redirectUri,
  isActive,
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
  params.push(id);
  await query(`UPDATE gam_clients SET ${fields.join(', ')} WHERE id = $${i}`, params);
  return getClientById(id);
}

async function ensureBootstrapFromEnv() {
  const networkCode = process.env.GAM_NETWORK_CODE;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!networkCode || !clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const existing = await getClientByNetworkCode(String(networkCode).trim());
  if (existing) {
    // Production: live requests use gam_clients (encrypted), not .env.
    // Set SYNC_GAM_CREDS_FROM_ENV=true once after rotating Google OAuth secrets, then restart.
    if (String(process.env.SYNC_GAM_CREDS_FROM_ENV || '').toLowerCase() === 'true') {
      const updated = await updateClientCredentials(existing.id, {
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
    return existing;
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
  createClient,
  updateClientCredentials,
  ensureBootstrapFromEnv,
};
