require('dotenv').config();
const { query } = require('../src/db');

async function main() {
  try {
    const username = process.argv[2] || 'testdomainuser1';
    const { rows } = await query('SELECT id, username, active_session_id, last_login FROM users WHERE username=$1', [username]);
    if (!rows.length) {
      console.log(`no user found for ${username}`);
      process.exit(1);
    }
    console.log(rows[0]);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
