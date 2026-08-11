#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initUsersSchema, getUserById, createUser } = require('../src/models/userStorePg');
const { query } = require('../src/db');
const logger = require('../src/utils/logger');

async function migrate() {
  const file = path.join(__dirname, '..', 'data', 'users.db.json');
  if (!fs.existsSync(file)) {
    console.error('No users.db.json found at', file);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = data.users || [];

  try {
    await initUsersSchema();
    let inserted = 0;
    for (const u of users) {
      const existing = await query('SELECT id FROM users WHERE id=$1', [u.id]);
      if (existing.rows && existing.rows.length) {
        logger.info(`Skipping existing user ${u.username} (${u.id})`);
        continue;
      }
      await createUser({ id: u.id, username: u.username, email: u.email, password: u.password || u.passwordHash || 'migrate', role: u.role, permissions: u.permissions });
      inserted++;
    }
    logger.info(`Migration complete. Inserted ${inserted} users.`);
    process.exit(0);
  } catch (e) {
    logger.error('Migration failed:', e.message);
    process.exit(2);
  }
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate };