/**
 * _lib/http.mjs — HTTP helpers shared across all Netlify Functions.
 *
 * Centralises:
 *   - JSON response shape (so the client can branch consistently)
 *   - CORS headers (single source of truth for allowed origin)
 *   - Rate limiting (per-IP, in-memory; good enough for cold-path
 *     abuse)
 *   - Client IP extraction (proxied through Netlify edge, then
 *     potentially through Cloudflare)
 *   - Audit logging (writes to the audit_log table for any
 *     mutation)
 */

import { query } from './db.mjs';

const ALLOWED_ORIGIN = 'https://cohort.tri-ai.org';

export const CORS = {
  'Access-Control-Allow-Origin':      ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods':     'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers':     'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function preflight() {
  return { statusCode: 204, headers: CORS, body: '' };
}

export function getClientIp(event) {
  return (
    event.headers['x-nf-client-connection-ip']
    || event.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers['client-ip']
    || 'unknown'
  );
}

// ─────────────────────────────────────────────────────────────
// In-memory rate limiting
// ─────────────────────────────────────────────────────────────
//
// One Map per function container. A cold start drops the state,
// which means a determined attacker can dodge the limit by waiting
// for a new container. This is fine for the goal here: stop casual
// scripts and accidental refresh loops. For real abuse defence
// you'd push this to Postgres or Redis; until that's a measured
// problem we don't pay that cost.

const buckets = new Map();

/**
 * Returns true if the request is within the limit, false if it's
 * being throttled. `key` should be a string like 'verify:<ip>'.
 * `max` is the number of allowed requests within `windowSec`.
 */
export function rateLimit(key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSec;
  const hits = (buckets.get(key) || []).filter(t => t > cutoff);
  hits.push(now);
  buckets.set(key, hits);
  // GC: keep the map bounded. If we exceed 5000 keys, drop the
  // oldest 1000. Crude but adequate.
  if (buckets.size > 5000) {
    const oldestKeys = [...buckets.keys()].slice(0, 1000);
    for (const k of oldestKeys) buckets.delete(k);
  }
  return hits.length <= max;
}

// ─────────────────────────────────────────────────────────────
// Audit logging
// ─────────────────────────────────────────────────────────────
//
// Every mutation should call audit(). Reads don't (too much noise).
// Failures here should NEVER block the user-facing response — we
// log and swallow.

export async function audit({
  action,
  actorEmail = null,
  actorKind  = 'organiser',
  targetType = null,
  targetId   = null,
  cohortId   = null,
  ip         = null,
  userAgent  = null,
  payload    = null,
}) {
  try {
    await query(
      `INSERT INTO audit_log
         (action, actor_email, actor_kind, target_type, target_id,
          cohort_id, ip, user_agent, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [action, actorEmail, actorKind, targetType, targetId,
       cohortId, ip, userAgent, payload]
    );
  } catch (err) {
    // Console.error gets surfaced in Netlify function logs. We do
    // NOT bubble this back to the user — the action succeeded; we
    // just failed to record it.
    console.error('audit_log write failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Body parsing
// ─────────────────────────────────────────────────────────────

export function parseJsonBody(event) {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Env-var guards
// ─────────────────────────────────────────────────────────────

/**
 * Call at the top of every function. Lists the env vars the
 * function requires; returns a 500 response if any are missing.
 * Same defensive pattern as in Phase 0.
 */
export function requireEnv(names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length > 0) {
    console.error('Missing env vars:', missing.join(', '));
    return json(500, { error: 'Service not configured. Contact cohorts@tri-ai.org.' });
  }
  return null;
}
