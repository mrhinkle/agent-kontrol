#!/usr/bin/env node
// Applies supabase/schema.sql (idempotent) to DATABASE_URL. Runs before every
// build and on every container start, so a fresh database is ready on first boot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, '..', 'supabase', 'schema.sql');
const databaseUrl = process.env.DATABASE_URL;
const RETRIES = 5;
const RETRY_DELAY_MS = Number(process.env.MC_MIGRATE_RETRY_MS) || 3000;

// A pg.Client cannot be reused after a failed connect, so each attempt gets its own.
async function connectWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 15000 });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function main() {
  if (!databaseUrl) {
    console.log('migrate: skipped (no DATABASE_URL; demo mode)');
    return;
  }
  if (process.env.MC_SKIP_MIGRATE === '1') {
    console.log('migrate: skipped (MC_SKIP_MIGRATE=1)');
    return;
  }

  const sqlText = fs.readFileSync(schemaPath, 'utf8');
  let client;
  try {
    client = await connectWithRetry();
    await client.query(sqlText);
    console.log('migrate: schema applied');
  } catch (err) {
    // Message only: never print the connection string.
    console.error(`migrate: failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

main();
