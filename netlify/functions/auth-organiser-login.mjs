/**
 * auth-organiser-login.mjs
 *
 * POST { email, password } — sets a session cookie if valid.
 *
 * Failed-login throttle: 5 strikes → 15-minute lockout. Successful
 * login zeroes the counter. This protects against a stolen
 * organiser email being credential-stuffed.
 *
 * We do not respond differently to "unknown email" vs "wrong
 * password" — both return the same generic message and consume
 * the same amount of time (we still run scrypt on a dummy hash
 * for unknown emails so the response timing is uniform).
 */

import { query, queryOne } from './_lib/db.mjs';
import {
  verifyPassword, newSessionToken, sessionCookieHeader, TOKEN_LIFETIMES,
} from './_lib/auth.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  rateLimit, getClientIp, audit,
} from './_lib/http.mjs';

// A constant scrypt hash to compare against for unknown emails.
// Computing it takes the same ~50ms as a real verify, so the
// response time doesn't leak whether the email exists.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$KCKpDpaJ0vO9bMK6tFKXQbCNJoXTRgVcuRoEh6CMRJ9MEC6cF6ZNvOcRgFOL3hCJtL5lj0vRWfYNk7QmA7vTRA==';

const GENERIC_FAIL = 'Incorrect email or password.';
const LOCKED = 'Too many failed attempts. Try again in 15 minutes or contact cohorts@tri-ai.org.';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['DATABASE_URL', 'SESSION_SECRET']);
  if (envCheck) return envCheck;

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const email    = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip       = getClientIp(event);
  const ua       = event.headers['user-agent'] || '';

  if (!email || !password) {
    return json(400, { error: 'Email and password are required.' });
  }

  // Per-IP rate limit at 10 attempts per 5 minutes — separate from
  // the per-account lockout below.
  if (!rateLimit(`org-login-ip:${ip}`, 10, 60 * 5)) {
    return json(429, { error: 'Too many attempts from this network. Wait 5 minutes.' });
  }

  const org = await queryOne(
    `SELECT id, email, password_hash, name, role, active,
            fail_count, fail_lockout_until
       FROM organisers
      WHERE email = $1`,
    [email]
  );

  // Run a verify regardless of whether the row exists — uniform timing.
  const hashToCheck = org?.password_hash || DUMMY_HASH;
  const passwordOk  = await verifyPassword(password, hashToCheck);

  // Now the various failure modes, in order:

  if (!org || !org.active) {
    await audit({
      action: 'org_login_failed', actorEmail: email,
      ip, userAgent: ua,
      payload: { reason: org ? 'inactive' : 'unknown_email' },
    });
    return json(401, { error: GENERIC_FAIL });
  }

  if (org.fail_lockout_until && new Date(org.fail_lockout_until) > new Date()) {
    await audit({
      action: 'org_login_blocked', actorEmail: email,
      ip, userAgent: ua,
      payload: { until: org.fail_lockout_until },
    });
    return json(429, { error: LOCKED });
  }

  if (!passwordOk) {
    // Increment fail count; lock if we hit 5.
    const newCount = (org.fail_count || 0) + 1;
    const lockUntil = newCount >= 5
      ? new Date(Date.now() + 15 * 60 * 1000)
      : null;
    await query(
      `UPDATE organisers
          SET fail_count = $2, fail_lockout_until = $3
        WHERE id = $1`,
      [org.id, newCount, lockUntil]
    );
    await audit({
      action: 'org_login_failed', actorEmail: email,
      ip, userAgent: ua,
      payload: { fail_count: newCount, locked: !!lockUntil },
    });
    return json(401, { error: GENERIC_FAIL });
  }

  // Success: reset fail counter, record login, set session cookie.
  await query(
    `UPDATE organisers
        SET fail_count = 0, fail_lockout_until = NULL, last_login_at = now()
      WHERE id = $1`,
    [org.id]
  );

  const token = newSessionToken({
    kind:  'organiser',
    email: org.email,
    role:  org.role,
  }, TOKEN_LIFETIMES.organiser);

  await audit({
    action: 'org_login_success', actorEmail: org.email,
    ip, userAgent: ua,
  });

  return json(200, {
    ok: true,
    name: org.name,
    role: org.role,
  }, {
    'Set-Cookie': sessionCookieHeader(token, TOKEN_LIFETIMES.organiser),
  });
};
