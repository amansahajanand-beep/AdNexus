/**
 * users.json based simple database
 * Production mein PostgreSQL/MongoDB use karein
 * Format: { users: [...], sessions: [...] }
 */
const usePg = process.env.USE_PG_USERS === 'true';

if (usePg) {
  const pg = require('./userStorePg');
  module.exports = {
    initDB: async () => await pg.initUsersSchema(),
    getAllUsers: async () => await pg.getAllUsers(),
    getUsersByClientId: async (clientId) => await pg.getUsersByClientId(clientId),
    getUserById: async (id) => await pg.getUserById(id),
    getUserByUsername: async (username) => await pg.getUserByUsername(username),
    createUser: async (opts) => await pg.createUser(opts),
    updateUser: async (id, updates) => await pg.updateUser(id, updates),
    deleteUser: async (id) => await pg.deleteUser(id),
    verifyPassword: async (username, password) => await pg.verifyPassword(username, password),
    checkPasswordForUser: (user, password) => pg.checkPasswordForUser(user, password),
    hashPassword: (pw) => pg.hashPassword(pw),
    toAdminSafeUser: (user) => pg.toAdminSafeUser(user),
  };
} else {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  const DB_PATH = path.join(__dirname, '../../data/users.db.json');

  // Ensure data dir exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Initialize DB file
  function initDB() {
    if (!fs.existsSync(DB_PATH)) {
      const seed = {
        users: [
          {
            id: 'admin-001',
            username: 'dashboard.mediamonetix',
            email: 'dashboard@mediamonetix.com',
            passwordHash: hashPassword('Mdmtx@3563ye'),
            role: 'admin',
            createdAt: new Date().toISOString(),
            isActive: true,
            permissions: null
          }
        ]
      };
      fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
      console.log('✅ DB initialized. Admin: dashboard.mediamonetix');
    }
  }

  function readDB() {
    initDB();
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  }

  function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  }

  function hashPassword(password) {
    return crypto.createHash('sha256').update(password + process.env.JWT_SECRET).digest('hex');
  }

  function toAdminSafeUser(user) {
    if (!user) return null;
    const { passwordHash, passwordEncrypted, activeSessionId, ...safe } = user;
    if (safe.role !== 'admin') {
      if (passwordEncrypted) {
        try {
          const { decryptSecret } = require('../utils/credentialsCrypto');
          safe.password = decryptSecret(passwordEncrypted);
        } catch (_) {
          safe.password = null;
        }
      } else {
        safe.password = null;
      }
    }
    return safe;
  }

  // ─── User CRUD ────────────────────────────────────────────────────────────────

  function getAllUsers() {
    const db = readDB();
    return db.users.map((u) => toAdminSafeUser(u));
  }

  function getUsersByClientId(clientId) {
    return getAllUsers().filter((u) => u.clientId === clientId);
  }

  function getUserById(id) {
    const db = readDB();
    return db.users.find(u => u.id === id) || null;
  }

  function getUserByUsername(username) {
    const db = readDB();
    return db.users.find(u => u.username === username) || null;
  }

  function createUser({ username, email, password, role, permissions, createdBy, clientId }) {
    const db = readDB();

    // Check duplicate
    if (db.users.find(u => u.username === username)) {
      throw new Error('Username already exists');
    }

    const { encryptSecret } = require('../utils/credentialsCrypto');
    const user = {
      id: `user-${Date.now()}`,
      username,
      email,
      passwordHash: hashPassword(password),
      passwordEncrypted: password ? encryptSecret(password) : null,
      role: role || 'child', // 'admin' | 'child'
      clientId: clientId || null,
      permissions: permissions || {
        canAccessDashboard: true,
        canAccessReporting: true,
        canAccessDomainUser: true,
        canLogin: true,
        canGenerateReports: true,
        canDownloadReports: true,
        canUseFilters: true,
        canUseReportBuilder: true,
        canSeeRevenue: true,
        canSeeImpressions: true,
        canSeeCTR: true,
        canSeeECPM: true,
        canSeeProgrammatic: true,
        canSeeOrders: false,
        canSeeInventory: false,
        allowedDomains: [],
        allowedSites: [],
        allowedAppIds: [],
        allowedAdUnits: [],
        dateRestriction: null,
      },
      createdBy: createdBy || 'admin',
      createdAt: new Date().toISOString(),
      isActive: true,
      lastLogin: null
    };

    db.users.push(user);
    writeDB(db);
    return toAdminSafeUser(user);
  }

  function updateUser(id, updates) {
    const db = readDB();
    const idx = db.users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error('User not found');

    if (updates.password) {
      const { encryptSecret } = require('../utils/credentialsCrypto');
      updates.passwordHash = hashPassword(updates.password);
      updates.passwordEncrypted = encryptSecret(updates.password);
      delete updates.password;
    }

    db.users[idx] = { ...db.users[idx], ...updates, id };
    writeDB(db);
    return db.users[idx];
  }

  function deleteUser(id) {
    const db = readDB();
    const idx = db.users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error('User not found');
    if (db.users[idx].role === 'admin' && db.users.filter(u => u.role === 'admin').length === 1) {
      throw new Error('Cannot delete the last admin user');
    }
    db.users.splice(idx, 1);
    writeDB(db);
    return true;
  }

  function verifyPassword(username, password) {
    const user = getUserByUsername(username);
    if (!user || !user.isActive) return null;
    if (!checkPasswordForUser(user, password)) return null;

    // Update last login
    updateUser(user.id, { lastLogin: new Date().toISOString() });
    const { passwordHash, passwordEncrypted, ...safe } = user;
    return safe;
  }

  function checkPasswordForUser(user, password) {
    if (!user?.passwordHash || !password) return false;
    return hashPassword(password) === user.passwordHash;
  }

  module.exports = {
    initDB,
    getAllUsers,
    getUsersByClientId,
    getUserById,
    getUserByUsername,
    createUser,
    updateUser,
    deleteUser,
    verifyPassword,
    checkPasswordForUser,
    hashPassword,
    toAdminSafeUser,
  };
}
