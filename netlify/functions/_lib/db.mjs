/**
 * _lib/db.mjs — Postgres connection management for Netlify Functions.
 *
 * Netlify Functions are stateless and short-lived, BUT — and this is
 * the important bit — when a function is invoked frequently, AWS Lambda
 * re-uses the same execution environment (warm starts). Module-level
 * state survives between invocations on a warm container.
 *
 * That means: if we create a Pool at module load, it persists. The
 * first invocation pays the connection cost; the next dozen don't.
 *
 * We use Pool, not Client, even though Lambdas are single-request,
 * because Pool's connection caching is the thing we want. We just
 * cap max connections low (3) so we don't blow out the homelab
 * Postgres's max_connections setting (default 100) when Netlify
 * spins up dozens of concurrent Lambda containers.
 *
 * A note on SSL: connecting to a homelab Postgres exposed through
 * Cloudflare Tunnel uses TLS to the tunnel edge. The certificate
 * presented is for the tunnel, not the database, so we accept it
 * without rejecting unknown CAs. If you ever switch to a directly-
 * exposed Postgres with a real cert (Let's Encrypt), flip
 * DATABASE_SSL_STRICT=true in env to enforce rejectUnauthorized.
 */

import pg from 'pg';

const { Pool } = pg;

// Lazily create the pool — Netlify cold starts are sensitive to
// top-level work, so we defer instantiation until first use.
let _pool = null;

export function pool() {
  if (_pool) return _pool;

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Cap at 3 connections per Lambda container. With ~30 concurrent
    // containers in a hot moment that's 90 total — comfortably under
    // a default Postgres max_connections of 100, and we can raise
    // either side independently if needed.
    max: 3,
    idleTimeoutMillis: 30_000,
    // If we can't connect in 5s, fail fast — students staring at a
    // spinner is worse than seeing "try again".
    connectionTimeoutMillis: 5_000,
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === 'true' },
  });

  // Suppress "unhandled promise rejection" noise when Lambda kills
  // the container with idle clients still in the pool.
  _pool.on('error', err => {
    console.error('pg pool error (likely Lambda freezing):', err.message);
  });

  return _pool;
}

/**
 * Convenience: run a single parameterised query and return rows.
 * Always parameterise — never concatenate user input into SQL.
 */
export async function query(text, params = []) {
  const res = await pool().query(text, params);
  return res.rows;
}

/**
 * Convenience for queries that should return exactly one row.
 * Returns null if no row, throws if more than one.
 */
export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`Expected at most 1 row, got ${rows.length}`);
  }
  return rows[0];
}

/**
 * Run a function inside a transaction. Commits on success, rolls
 * back on any throw. Use for any multi-statement write — the
 * accept-applicant flow, for instance, inserts into enrolments AND
 * updates applications AND writes to audit_log. All-or-nothing.
 */
export async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}
