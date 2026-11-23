/** Per-user Google Sheets export connection (table user_sheet_exports). */
const { query } = require('../db');

const COLS = `user_id, client_id, spreadsheet_id, spreadsheet_title, enabled,
  last_run_at, last_status, last_error, last_result, created_at, updated_at`;

async function getConnection(userId) {
  const { rows } = await query(`SELECT ${COLS} FROM user_sheet_exports WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

async function listEnabledConnections() {
  const { rows } = await query(`SELECT ${COLS} FROM user_sheet_exports WHERE enabled = true ORDER BY created_at`);
  return rows;
}

async function saveConnection({ userId, clientId, spreadsheetId, spreadsheetTitle }) {
  const { rows } = await query(
    `INSERT INTO user_sheet_exports (user_id, client_id, spreadsheet_id, spreadsheet_title, enabled)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (user_id) DO UPDATE
       SET client_id = EXCLUDED.client_id, spreadsheet_id = EXCLUDED.spreadsheet_id,
           spreadsheet_title = EXCLUDED.spreadsheet_title, enabled = true,
           last_status = NULL, last_error = NULL, updated_at = now()
     RETURNING ${COLS}`,
    [userId, clientId, spreadsheetId, spreadsheetTitle || '']
  );
  return rows[0];
}

async function setEnabled(userId, enabled) {
  const { rows } = await query(
    `UPDATE user_sheet_exports SET enabled = $2, updated_at = now() WHERE user_id = $1 RETURNING ${COLS}`,
    [userId, !!enabled]
  );
  return rows[0] || null;
}

async function removeConnection(userId) {
  await query(`DELETE FROM user_sheet_exports WHERE user_id = $1`, [userId]);
}

async function recordRun(userId, { ok, error, result }) {
  await query(
    `UPDATE user_sheet_exports
        SET last_run_at = now(), last_status = $2, last_error = $3, last_result = $4::jsonb
      WHERE user_id = $1`,
    [userId, ok ? 'ok' : 'error', ok ? null : String(error || '').slice(0, 500), JSON.stringify(result || null)]
  );
}

module.exports = { getConnection, listEnabledConnections, saveConnection, setEnabled, removeConnection, recordRun };
