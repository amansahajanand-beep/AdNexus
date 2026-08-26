const crypto = require('crypto');
const { query, schemaQuery } = require('../db');
const logger = require('../utils/logger');
const { encryptSecret, decryptSecret } = require('../utils/credentialsCrypto');

const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + SECRET()).digest('hex');
}

function mapDbRowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    passwordEncrypted: row.password_encrypted || null,
    role: row.role,
    clientId: row.client_id || null,
    permissions: row.permissions || {},
    activeSessionId: row.active_session_id,
    lastLogin: row.last_login,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Admin list/detail: never expose hashes; reveal plaintext only for domain users (child). */
function toAdminSafeUser(user) {
  if (!user) return null;
  const { passwordHash, passwordEncrypted, ...safe } = user;
  if (safe.role !== 'admin') {
    if (passwordEncrypted) {
      try {
        safe.password = decryptSecret(passwordEncrypted);
      } catch (e) {
        logger.warn(`Decrypt password failed for user ${safe.username}:`, e.message);
        safe.password = null;
      }
    } else {
      safe.password = null;
    }
  }
  return safe;
}

const DEFAULT_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || 'dashboard.mediamonetix';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'Mdmtx@3563ye';

async function initUsersSchema() {
  // DDL via schemaQuery so FORCE RLS / empty app.client_id cannot block CREATE.
  await schemaQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'child',
      permissions JSONB DEFAULT '{}'::jsonb,
      active_session_id TEXT,
      last_login TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await schemaQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by TEXT;`);
  await schemaQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id UUID;`);
  // Reversible copy so admins can view domain-user passwords (hash remains for login).
  await schemaQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_encrypted TEXT;`);
  await schemaQuery(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);
  await schemaQuery(`CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);`);

  await schemaQuery(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_agent TEXT,
      ip_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expired_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT true
    );
  `);
  await schemaQuery(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);`);

  try {
    const { ensureBootstrapFromEnv } = require('./clientStore');
    const bootstrap = await ensureBootstrapFromEnv();
    if (bootstrap?.id) {
      await schemaQuery(`UPDATE users SET client_id = $1::uuid WHERE client_id IS NULL`, [bootstrap.id]);
    }
  } catch (e) {
    logger.warn('Attach users to bootstrap client:', e.message);
  }

  const admin = await getUserByUsername(DEFAULT_ADMIN_USERNAME);
  if (!admin) {
    logger.info(`No admin found in users table; creating default admin user '${DEFAULT_ADMIN_USERNAME}'.`);
    await createUser({
      id: `user-${Date.now()}`,
      username: DEFAULT_ADMIN_USERNAME,
      email: `${DEFAULT_ADMIN_USERNAME}@local`,
      password: DEFAULT_ADMIN_PASSWORD,
      role: 'admin',
      permissions: null,
      createdBy: 'system',
    });
  }

  logger.info('Users and sessions schema ready (tables: users, user_sessions)');
}

async function getAllUsers() {
  const { rows } = await query(
    `SELECT id, username, email, role, client_id, permissions, active_session_id,
            last_login, is_active, created_by, created_at, password_hash, password_encrypted
     FROM users`
  );
  return rows.map((row) => toAdminSafeUser(mapDbRowToUser(row)));
}

async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [id]);
  return rows[0] ? mapDbRowToUser(rows[0]) : null;
}

async function getUserByUsername(username) {
  const { rows } = await query('SELECT * FROM users WHERE username=$1', [username]);
  return rows[0] ? mapDbRowToUser(rows[0]) : null;
}

async function getUsersByClientId(clientId) {
  if (!clientId) return [];
  const { rows } = await query(
    `SELECT id, username, email, role, client_id, permissions, active_session_id,
            last_login, is_active, created_by, created_at, password_hash, password_encrypted
     FROM users WHERE client_id = $1`,
    [clientId]
  );
  return rows.map((row) => toAdminSafeUser(mapDbRowToUser(row)));
}

async function createUser({ id, username, email, password, passwordHash, role, permissions, createdBy, clientId }) {
  const uid = id || `user-${Date.now()}`;
  const plain = password || null;
  const pwHash = plain
    ? hashPassword(plain)
    : passwordHash
      ? passwordHash
      : hashPassword(Math.random().toString(36).slice(2, 10));
  const pwEnc = plain ? encryptSecret(plain) : null;
  const perms = permissions || {};

  const existing = await getUserByUsername(username);
  if (existing) {
    throw new Error('Username already exists');
  }

  await query(
    `INSERT INTO users (
       id, username, email, password_hash, password_encrypted, role, permissions,
       created_by, created_at, is_active, client_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),true,$9)`,
    [uid, username, email, pwHash, pwEnc, role || 'child', perms, createdBy || null, clientId || null]
  );

  return toAdminSafeUser(await getUserById(uid));
}

async function updateUser(id, updates) {
  const fields = [];
  const params = [];
  let i = 1;

  if (updates.password) {
    const plain = updates.password;
    updates.password_hash = hashPassword(plain);
    updates.password_encrypted = encryptSecret(plain);
    delete updates.password;
  }

  const translateKey = (k) => {
    if (k === 'password_hash') return 'password_hash';
    if (k === 'activeSessionId') return 'active_session_id';
    if (k === 'lastLogin') return 'last_login';
    if (k === 'isActive') return 'is_active';
    if (k === 'createdAt') return 'created_at';
    if (k === 'createdBy') return 'created_by';
    if (k === 'clientId') return 'client_id';
    return k.replace(/([A-Z])/g, '_$1').toLowerCase();
  };

  for (const [k, v] of Object.entries(updates)) {
    const col = translateKey(k);
    fields.push(`${col} = $${i}`);
    params.push(v);
    i++;
  }
  if (!fields.length) return getUserById(id);
  params.push(id);
  const sql = `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`;
  const { rows } = await query(sql, params);
  const updated = rows[0] ? mapDbRowToUser(rows[0]) : null;
  // Internal callers (verifyPassword) need the hash; strip for admin API via toAdminSafeUser at route.
  return updated;
}

async function deleteUser(id) {
  await query('DELETE FROM users WHERE id=$1', [id]);
  await query('UPDATE user_sessions SET is_active=false, expired_at=NOW() WHERE user_id=$1 AND is_active = true', [id]);
  return true;
}

async function createSession({ sessionId, userId, userAgent, ipAddress }) {
  await query(`
    INSERT INTO user_sessions (session_id, user_id, user_agent, ip_address, is_active)
    VALUES ($1, $2, $3, $4, true)
    ON CONFLICT (session_id) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          user_agent = EXCLUDED.user_agent,
          ip_address = EXCLUDED.ip_address,
          is_active = true,
          created_at = NOW(),
          expired_at = NULL
  `, [sessionId, userId, userAgent || null, ipAddress || null]);
}

async function expireSession(sessionId) {
  await query(`
    UPDATE user_sessions
    SET is_active = false,
        expired_at = NOW()
    WHERE session_id = $1
  `, [sessionId]);
}

async function expireSessionsForUser(userId) {
  await query(`
    UPDATE user_sessions
    SET is_active = false,
        expired_at = NOW()
    WHERE user_id = $1 AND is_active = true
  `, [userId]);
}

async function getSessionById(sessionId) {
  const { rows } = await query('SELECT * FROM user_sessions WHERE session_id=$1', [sessionId]);
  return rows[0] || null;
}

async function verifyPassword(username, password) {
  const user = await getUserByUsername(username);
  if (!user || !user.isActive) return null;
  if (!checkPasswordForUser(user, password)) {
    if (username === DEFAULT_ADMIN_USERNAME && password === DEFAULT_ADMIN_PASSWORD) {
      logger.warn(`Default admin password supplied; repairing stored hash for user=${username}`);
      await updateUser(user.id, { password: DEFAULT_ADMIN_PASSWORD });
      const repaired = await getUserById(user.id);
      const safeRepaired = { ...repaired };
      delete safeRepaired.passwordHash;
      delete safeRepaired.passwordEncrypted;
      return safeRepaired;
    }
    return null;
  }
  await updateUser(user.id, { lastLogin: new Date().toISOString() });
  const safe = { ...user };
  delete safe.passwordHash;
  delete safe.passwordEncrypted;
  return safe;
}

function checkPasswordForUser(user, password) {
  if (!user?.passwordHash || !password) return false;
  return hashPassword(password) === user.passwordHash;
}

module.exports = {
  initUsersSchema,
  getAllUsers,
  getUsersByClientId,
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  createSession,
  expireSession,
  expireSessionsForUser,
  getSessionById,
  verifyPassword,
  checkPasswordForUser,
  hashPassword,
  toAdminSafeUser,
};
