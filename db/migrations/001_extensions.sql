-- ============================================================
-- 001 - Extensions and shared helpers
--
-- Run order: this must be first. Subsequent migrations assume
-- pgcrypto's gen_random_uuid() is available for UUID primary keys
-- and citext is loaded for case-insensitive email comparisons.
--
-- All migrations are idempotent: re-running them on an existing
-- database should produce no errors and no changes. This lets us
-- replay the full migration set against a freshly-restored backup
-- without worrying about ordering or state.
-- ============================================================

-- gen_random_uuid() — random UUIDs without an extra library
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- citext — case-insensitive text type. We use it for email so that
-- 'Tunde@example.com' and 'tunde@example.com' are treated as the
-- same value at the database level. This is the simplest defence
-- against the spreadsheet-era bug where the same person showed up
-- as two rows because they capitalised their email differently.
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Shared trigger: updated_at maintenance ──────────────────────
-- Every table that mutates carries an updated_at column. This trigger
-- function sets it on every UPDATE. Defining it once at the top means
-- per-table triggers are one line each.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Schema versioning ──────────────────────────────────────────
-- A trivial migrations table so we can tell at a glance which
-- migrations have been applied. The migration runner (see
-- db/run-migrations.mjs) reads from here and skips already-applied
-- files.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename     text PRIMARY KEY,
  applied_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (filename)
VALUES ('001_extensions.sql')
ON CONFLICT (filename) DO NOTHING;
