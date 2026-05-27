#!/usr/bin/env node
/**
 * run-migrations.mjs
 *
 * Apply every .sql file in ./migrations to the configured Postgres
 * database, in alphabetical order, skipping any already recorded
 * in schema_migrations.
 *
 * Usage:
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/db node db/run-migrations.mjs
 *
 * Idempotent. Safe to re-run. Each migration is wrapped in a
 * transaction — if a migration fails, nothing in that file is
 * committed, and the script aborts before touching subsequent
 * migrations.
 *
 * Note: this script doesn't use a migration library on purpose.
 * Five migrations is not enough complexity to justify pulling in
 * Prisma/Drizzle/etc. If we cross 20 migrations or need rollbacks,
 * graduate to a real tool.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  console.error('Usage: DATABASE_URL=postgres://... node db/run-migrations.mjs');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: false },   // self-signed certs on homelab are OK
});

async function run() {
  await client.connect();
  console.log(`Connected to ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);

  // Bootstrap: make sure the migrations table exists before we read it.
  // The first migration creates it idempotently, but we need to be able
  // to QUERY it before applying any migration, hence this one-shot.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedRes = await client.query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map(r => r.filename));

  const dir = join(__dirname, 'migrations');
  const files = (await readdir(dir))
    .filter(f => f.endsWith('.sql'))
    .sort();

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip   ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    console.log(`  apply  ${file}`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      // The migration files do their own INSERT into schema_migrations,
      // but in case one forgets we add a belt-and-braces here.
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
      await client.query('COMMIT');
      appliedCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`\nFAILED on ${file}:`);
      console.error(err.message);
      process.exit(1);
    }
  }

  console.log(`\nDone. ${appliedCount} migration(s) applied, ${applied.size} were already in place.`);
  await client.end();
}

run().catch(err => {
  console.error('Migration run failed:', err);
  process.exit(1);
});
