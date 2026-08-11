#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const host = process.env.PG_HOST || 'localhost';
  const port = parseInt(process.env.PG_PORT, 10) || 5432;
  const user = process.env.PG_USER || 'postgres';
  const password = process.env.PG_PASSWORD || '';
  const dbName = process.env.PG_DATABASE || 'AdNexus';
  const ssl = process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false;

  const pool = new Pool({ host, port, user, password, database: 'postgres', ssl });
  try {
    await pool.query(`CREATE DATABASE "${dbName}"`);
    console.log(`created ${dbName}`);
  } catch (err) {
    if (err.code === '42P04') {
      console.log(`database already exists ${dbName}`);
    } else {
      console.error('create-db error', err.message);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
