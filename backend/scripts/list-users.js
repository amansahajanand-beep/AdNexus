require('dotenv').config();
const { query } = require('../src/db');

async function main() {
  try {
    const res = await query('SELECT id, username, email, role, permissions, active_session_id, last_login FROM users ORDER BY username');
    console.log('count', res.rows.length);
    console.log(res.rows);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
