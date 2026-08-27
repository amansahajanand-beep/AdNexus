const crypto = require('crypto');
const { query } = require('../db');
const { encryptSecret, decryptSecret } = require('../utils/credentialsCrypto');

function normalizeCustomerId(raw) {
  return String(raw || '').replace(/[-\s]/g, '').trim();
}

function mapPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    accountType: row.account_type,
    customerId: row.customer_id || '',
    descriptiveName: row.descriptive_name || '',
    parentMccId: row.parent_mcc_id || null,
    loginCustomerId: row.login_customer_id || null,
    isActive: row.is_active !== false,
    includeInRoi: row.include_in_roi !== false,
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
    `SELECT * FROM ads_accounts WHERE client_id = $1 ORDER BY account_type DESC, descriptive_name ASC, created_at ASC`,
    [clientId]
  );
  return rows.map(mapPublic);
}

async function listRoiClientAccounts(clientId) {
  const { rows } = await query(
    `SELECT * FROM ads_accounts
     WHERE client_id = $1
       AND account_type = 'client'
       AND is_active = true
       AND include_in_roi = true
     ORDER BY descriptive_name ASC, customer_id ASC`,
    [clientId]
  );
  return rows.map(mapPublic);
}

async function listSyncableClientAccounts(clientId) {
  const { rows } = await query(
    `SELECT a.*,
            COALESCE(a.google_refresh_token_enc, m.google_refresh_token_enc) AS google_refresh_token_enc,
            COALESCE(
              NULLIF(a.login_customer_id, ''),
              m.customer_id,
              (
                SELECT mcc.customer_id
                FROM ads_accounts mcc
                WHERE mcc.client_id = a.client_id
                  AND mcc.account_type = 'mcc'
                  AND mcc.is_active = true
                  AND mcc.google_refresh_token_enc IS NOT NULL
                ORDER BY mcc.created_at ASC
                LIMIT 1
              )
            ) AS effective_login_customer_id
     FROM ads_accounts a
     LEFT JOIN ads_accounts m ON m.id = a.parent_mcc_id
     WHERE a.client_id = $1
       AND a.account_type = 'client'
       AND a.is_active = true
       AND COALESCE(a.google_refresh_token_enc, m.google_refresh_token_enc) IS NOT NULL
       AND NULLIF(TRIM(a.customer_id), '') IS NOT NULL`,
    [clientId]
  );
  return rows.map((row) => {
    const runtime = mapRuntime(row);
    return {
      ...runtime,
      loginCustomerId: row.effective_login_customer_id || runtime.loginCustomerId || null,
    };
  });
}

async function getAccountById(id) {
  const { rows } = await query('SELECT * FROM ads_accounts WHERE id = $1', [id]);
  return rows[0] ? mapRuntime(rows[0]) : null;
}

async function getAccountPublicById(id) {
  const { rows } = await query('SELECT * FROM ads_accounts WHERE id = $1', [id]);
  return rows[0] ? mapPublic(rows[0]) : null;
}

async function getAccountByCustomerId(clientId, customerId) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) return null;
  const { rows } = await query(
    'SELECT * FROM ads_accounts WHERE client_id = $1 AND customer_id = $2',
    [clientId, cid]
  );
  return rows[0] ? mapRuntime(rows[0]) : null;
}

async function createAccount({
  clientId,
  accountType,
  customerId = '',
  descriptiveName = '',
  parentMccId = null,
  loginCustomerId = null,
  refreshToken = null,
  includeInRoi = true,
  isActive = true,
}) {
  const id = crypto.randomUUID();
  const cid = normalizeCustomerId(customerId) || `pending-${id.slice(0, 8)}`;
  const { rows } = await query(
    `INSERT INTO ads_accounts (
       id, client_id, account_type, customer_id, descriptive_name,
       parent_mcc_id, login_customer_id, google_refresh_token_enc,
       is_active, include_in_roi
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      id,
      clientId,
      accountType,
      cid,
      descriptiveName || (accountType === 'mcc' ? 'MCC' : cid),
      parentMccId,
      loginCustomerId ? normalizeCustomerId(loginCustomerId) : null,
      refreshToken ? encryptSecret(refreshToken) : null,
      isActive !== false,
      includeInRoi !== false,
    ]
  );
  return mapPublic(rows[0]);
}

async function updateAccount(id, patch = {}) {
  const current = await getAccountById(id);
  if (!current) return null;

  const next = {
    customerId: patch.customerId != null ? normalizeCustomerId(patch.customerId) : current.customerId,
    descriptiveName: patch.descriptiveName != null ? String(patch.descriptiveName) : current.descriptiveName,
    parentMccId: patch.parentMccId !== undefined ? patch.parentMccId : current.parentMccId,
    loginCustomerId: patch.loginCustomerId !== undefined
      ? (patch.loginCustomerId ? normalizeCustomerId(patch.loginCustomerId) : null)
      : current.loginCustomerId,
    isActive: patch.isActive != null ? !!patch.isActive : current.isActive,
    includeInRoi: patch.includeInRoi != null ? !!patch.includeInRoi : current.includeInRoi,
    refreshTokenEnc: current.refreshToken ? encryptSecret(current.refreshToken) : null,
  };

  if (patch.refreshToken) {
    next.refreshTokenEnc = encryptSecret(patch.refreshToken);
  }

  const { rows } = await query(
    `UPDATE ads_accounts SET
       customer_id = $2,
       descriptive_name = $3,
       parent_mcc_id = $4,
       login_customer_id = $5,
       google_refresh_token_enc = COALESCE($6, google_refresh_token_enc),
       is_active = $7,
       include_in_roi = $8,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      next.customerId,
      next.descriptiveName,
      next.parentMccId,
      next.loginCustomerId,
      next.refreshTokenEnc,
      next.isActive,
      next.includeInRoi,
    ]
  );
  return mapPublic(rows[0]);
}

async function setSyncStatus(id, { error = null } = {}) {
  await query(
    `UPDATE ads_accounts SET
       last_sync_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sync_at END,
       last_sync_error = $2,
       updated_at = now()
     WHERE id = $1`,
    [id, error]
  );
}

async function upsertChildUnderMcc(clientId, mccId, { customerId, descriptiveName, includeInRoi = false }) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) throw new Error('customerId required');
  const mcc = await getAccountById(mccId);
  const loginId = mcc?.customerId || null;
  const existing = await getAccountByCustomerId(clientId, cid);
  if (existing) {
    await query(
      `UPDATE ads_accounts SET
         account_type = 'client',
         descriptive_name = COALESCE(NULLIF($2, ''), descriptive_name),
         parent_mcc_id = $3,
         login_customer_id = $4,
         updated_at = now()
       WHERE id = $1`,
      [existing.id, descriptiveName || '', mccId, loginId]
    );
    return getAccountPublicById(existing.id);
  }
  return createAccount({
    clientId,
    accountType: 'client',
    customerId: cid,
    descriptiveName: descriptiveName || cid,
    parentMccId: mccId,
    loginCustomerId: loginId,
    includeInRoi,
    isActive: true,
  });
}

async function deleteAccount(id) {
  await query('DELETE FROM ads_accounts WHERE id = $1', [id]);
}

async function listCampaignMaps(clientId) {
  const { rows } = await query(
    `SELECT m.*, a.descriptive_name AS account_name, a.customer_id
     FROM ads_campaign_map m
     JOIN ads_accounts a ON a.id = m.ads_account_id
     WHERE m.client_id = $1
     ORDER BY a.descriptive_name, m.campaign_name`,
    [clientId]
  );
  return rows.map((r) => ({
    id: r.id,
    adsAccountId: r.ads_account_id,
    accountName: r.account_name,
    customerId: r.customer_id,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    targetType: r.target_type,
    targetKey: r.target_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function upsertCampaignMap({
  clientId,
  adsAccountId,
  campaignId,
  campaignName = '',
  targetType,
  targetKey,
}) {
  const id = crypto.randomUUID();
  const key = String(targetKey || '').trim().toLowerCase();
  if (!key) throw new Error('targetKey required');
  if (!['site', 'app'].includes(targetType)) throw new Error('targetType must be site or app');
  const { rows } = await query(
    `INSERT INTO ads_campaign_map (
       id, client_id, ads_account_id, campaign_id, campaign_name, target_type, target_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (client_id, ads_account_id, campaign_id)
     DO UPDATE SET
       campaign_name = EXCLUDED.campaign_name,
       target_type = EXCLUDED.target_type,
       target_key = EXCLUDED.target_key,
       updated_at = now()
     RETURNING *`,
    [id, clientId, adsAccountId, String(campaignId), campaignName || '', targetType, key]
  );
  return rows[0];
}

async function deleteCampaignMap(id, clientId) {
  await query('DELETE FROM ads_campaign_map WHERE id = $1 AND client_id = $2', [id, clientId]);
}

async function listOtherExpenses(clientId, { start, end } = {}) {
  const params = [clientId];
  let sql = `SELECT * FROM roi_other_expenses WHERE client_id = $1`;
  if (start) {
    params.push(start);
    sql += ` AND expense_date >= $${params.length}`;
  }
  if (end) {
    params.push(end);
    sql += ` AND expense_date <= $${params.length}`;
  }
  sql += ' ORDER BY expense_date DESC, created_at DESC';
  const { rows } = await query(sql, params);
  return rows.map((r) => ({
    id: r.id,
    expenseDate: r.expense_date,
    amount: Number(r.amount) || 0,
    label: r.label || '',
    targetType: r.target_type,
    targetKey: r.target_key || '',
    notes: r.notes || '',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function createOtherExpense({
  clientId,
  expenseDate,
  amount,
  label = '',
  targetType = 'general',
  targetKey = '',
  notes = '',
  createdBy = null,
}) {
  if (!['site', 'app', 'general'].includes(targetType)) {
    throw new Error('targetType must be site, app, or general');
  }
  const id = crypto.randomUUID();
  const key = targetType === 'general' ? '' : String(targetKey || '').trim().toLowerCase();
  if (targetType !== 'general' && !key) throw new Error('targetKey required for site/app expenses');
  const createdByText = createdBy != null && String(createdBy).trim() !== ''
    ? String(createdBy)
    : null;
  const { rows } = await query(
    `INSERT INTO roi_other_expenses (
       id, client_id, expense_date, amount, label, target_type, target_key, notes, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [id, clientId, expenseDate, Number(amount), label || '', targetType, key, notes || null, createdByText]
  );
  return {
    id: rows[0].id,
    expenseDate: rows[0].expense_date,
    amount: Number(rows[0].amount) || 0,
    label: rows[0].label || '',
    targetType: rows[0].target_type,
    targetKey: rows[0].target_key || '',
    notes: rows[0].notes || '',
  };
}

async function deleteOtherExpense(id, clientId) {
  await query('DELETE FROM roi_other_expenses WHERE id = $1 AND client_id = $2', [id, clientId]);
}

async function upsertSpendRows(clientId, adsAccountId, rows) {
  if (!rows?.length) return 0;
  let n = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO ads_spend_daily (
         client_id, ads_account_id, report_date, campaign_id, campaign_name,
         cost, clicks, impressions, conversions, conversion_value, currency, synced_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (client_id, ads_account_id, report_date, campaign_id)
       DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name,
         cost = EXCLUDED.cost,
         clicks = EXCLUDED.clicks,
         impressions = EXCLUDED.impressions,
         conversions = EXCLUDED.conversions,
         conversion_value = EXCLUDED.conversion_value,
         currency = EXCLUDED.currency,
         synced_at = now()`,
      [
        clientId,
        adsAccountId,
        r.reportDate,
        String(r.campaignId),
        r.campaignName || '',
        Number(r.cost) || 0,
        Number(r.clicks) || 0,
        Number(r.impressions) || 0,
        Number(r.conversions) || 0,
        Number(r.conversionValue) || 0,
        r.currency || 'USD',
      ]
    );
    n += 1;
  }
  return n;
}

module.exports = {
  normalizeCustomerId,
  listAccounts,
  listRoiClientAccounts,
  listSyncableClientAccounts,
  getAccountById,
  getAccountPublicById,
  getAccountByCustomerId,
  createAccount,
  updateAccount,
  setSyncStatus,
  upsertChildUnderMcc,
  deleteAccount,
  listCampaignMaps,
  upsertCampaignMap,
  deleteCampaignMap,
  listOtherExpenses,
  createOtherExpense,
  deleteOtherExpense,
  upsertSpendRows,
  mapPublic,
  mapRuntime,
};
