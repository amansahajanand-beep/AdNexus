require('dotenv').config();
const { schemaQuery, pool } = require('../src/db');

schemaQuery(`ALTER TABLE report_grain ADD COLUMN IF NOT EXISTS slice_key TEXT NOT NULL DEFAULT ''`)
  .then(() => { console.log('slice_key column ready'); return pool.end(); })
  .catch((e) => { console.error(e); process.exit(1); });
