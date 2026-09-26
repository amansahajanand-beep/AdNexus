/**
 * Shared store factory for AdMob / AdSense publisher accounts.
 */
const crypto = require('crypto');
const { query } = require('../db');
const { encryptSecret, decryptSecret } = require('../utils/credentialsCrypto');

function createPublisherAccountStore(tableName) {
  if (!/^[a-z_]+$/.test(tableName)) throw new Error(`Invalid table: ${tableName}`);

  function mapPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      clientId: row.client_id,
      accountId: row.account_id || '',
      descriptiveName: row.descriptive_name || '',
      currencyCode: row.currency_code || 'USD',
      reportingTimeZone: row.reporting_time_zone || null,
      isActive: row.is_active !== false,
      hasRefreshToken: !!row.google_refresh_token_enc,
      lastSyncAt: row.last_sync_at || null,
      lastSyncError: row.last_sync_error || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapRuntime(row) {
    if (!row) return null;
    return {
      ...mapPublic(row),
      refreshToken: row.google_refresh_token_enc ? decryptSecret(row.google_refresh_token_enc) : null,
    };
  }

  async function listAccounts(clientId) {
    const { rows } = await query(
      `SELECT * FROM ${tableName} WHERE client_id = $1 ORDER BY descriptive_name ASC, created_at ASC`,
      [clientId]
    );
    return rows.map(mapPublic);
  }

  async function listSyncableAccounts(clientId) {
    const { rows } = await query(
      `SELECT * FROM ${tableName}
       WHERE client_id = $1
         AND is_active = true
         AND google_refresh_token_enc IS NOT NULL
         AND NULLIF(TRIM(account_id), '') IS NOT NULL
       ORDER BY last_sync_at ASC NULLS FIRST, account_id ASC`,
      [clientId]
    );
    return rows.map(mapRuntime);
  }

  async function getAccountById(id) {
    const { rows } = await query(`SELECT * FROM ${tableName} WHERE id = $1`, [id]);
    return rows[0] ? mapRuntime(rows[0]) : null;
  }

  async function getAccountByPublisherId(clientId, accountId) {
    const { rows } = await query(
      `SELECT * FROM ${tableName} WHERE client_id = $1 AND account_id = $2`,
      [clientId, String(accountId || '').trim()]
    );
    return rows[0] ? mapRuntime(rows[0]) : null;
  }

  async function createAccount({
    clientId,
    accountId,
    descriptiveName = '',
    currencyCode = 'USD',
    reportingTimeZone = null,
    refreshToken = null,
    isActive = true,
  }) {
    const id = crypto.randomUUID();
    const enc = refreshToken ? encryptSecret(refreshToken) : null;
    await query(
      `INSERT INTO ${tableName} (
         id, client_id, account_id, descriptive_name, currency_code,
         reporting_time_zone, google_refresh_token_enc, is_active, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())`,
      [
        id,
        clientId,
        String(accountId || '').trim(),
        descriptiveName || String(accountId || ''),
        (currencyCode || 'USD').slice(0, 3).toUpperCase(),
        reportingTimeZone || null,
        enc,
        isActive !== false,
      ]
    );
    return getAccountById(id);
  }

  async function updateAccount(id, patch = {}) {
    const fields = [];
    const params = [];
    const set = (col, val) => {
      params.push(val);
      fields.push(`${col} = $${params.length}`);
    };
    if (patch.accountId != null) set('account_id', String(patch.accountId).trim());
    if (patch.descriptiveName != null) set('descriptive_name', patch.descriptiveName);
    if (patch.currencyCode != null) set('currency_code', String(patch.currencyCode).slice(0, 3).toUpperCase());
    if (patch.reportingTimeZone !== undefined) {
      set('reporting_time_zone', patch.reportingTimeZone || null);
    }
    if (patch.isActive != null) set('is_active', !!patch.isActive);
    if (patch.refreshToken !== undefined) {
      set('google_refresh_token_enc', patch.refreshToken ? encryptSecret(patch.refreshToken) : null);
    }
    if (!fields.length) return getAccountById(id);
    params.push(id);
    await query(
      `UPDATE ${tableName} SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params
    );
    return getAccountById(id);
  }

  async function upsertAccount(clientId, {
    accountId,
    descriptiveName,
    currencyCode,
    reportingTimeZone,
    refreshToken,
  }) {
    const existing = await getAccountByPublisherId(clientId, accountId);
    if (existing) {
      return updateAccount(existing.id, {
        descriptiveName: descriptiveName || existing.descriptiveName,
        currencyCode: currencyCode || existing.currencyCode,
        reportingTimeZone: reportingTimeZone !== undefined
          ? reportingTimeZone
          : existing.reportingTimeZone,
        refreshToken: refreshToken != null ? refreshToken : undefined,
        isActive: true,
      });
    }
    return createAccount({
      clientId,
      accountId,
      descriptiveName,
      currencyCode,
      reportingTimeZone,
      refreshToken,
    });
  }

  async function setSyncStatus(id, { error = null } = {}) {
    await query(
      `UPDATE ${tableName}
       SET last_sync_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sync_at END,
           last_sync_error = $2,
           updated_at = now()
       WHERE id = $1`,
      [id, error]
    );
  }

  async function deleteAccount(id) {
    // Soft-clear token; keep row for history links
    await query(
      `UPDATE ${tableName}
       SET google_refresh_token_enc = NULL, is_active = false, updated_at = now()
       WHERE id = $1`,
      [id]
    );
  }

  async function hardDeleteAccount(id) {
    await query(`DELETE FROM ${tableName} WHERE id = $1`, [id]);
  }

  return {
    tableName,
    mapPublic,
    mapRuntime,
    listAccounts,
    listSyncableAccounts,
    getAccountById,
    getAccountByPublisherId,
    createAccount,
    updateAccount,
    upsertAccount,
    setSyncStatus,
    deleteAccount,
    hardDeleteAccount,
  };
}

const admobAccountStore = createPublisherAccountStore('admob_accounts');
const adsenseAccountStore = createPublisherAccountStore('adsense_accounts');

module.exports = {
  createPublisherAccountStore,
  admobAccountStore,
  adsenseAccountStore,
};
