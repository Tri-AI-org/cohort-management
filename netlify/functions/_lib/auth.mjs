/**
 * _lib/auth.mjs — Authentication primitives.
 *
 * Three user kinds, three flows:
 *
 *   1. Students / facilitators — magic links. The user enters their
 *      email; we email them a one-time link; clicking the link sets a
 *      session cookie. No password.
 *
 *   2. Organisers — email + password. Password is bcrypt-hashed.
 *      Failed-login throttle: 5 strikes → 15-minute lockout.
 *
 *   3. Anonymous — the attendance verify flow before the session is
 *      established. Limited write surface (you can submit attendance
 *      for the verified email, nothing else) so the auth bar is
 *      proportionally lower.
 *
 * Sessions are signed JWTs in HttpOnly+Secure+SameSite=Lax cookies.
 * We don't use a JWT library — a JWT is just <header>.<payload>.<sig>
 * with HMAC-SHA256, and rolling our own avoids a 200kb dependency
 * for what's effectively 40 lines of code.
 */

import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  createHash,
  scrypt as scryptCb,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const SESSION_COOKIE   = 'cohort_session';
const SESSION_LIFETIME = 60 * 60 * 8;            // 8 hours for organisers
const STUDENT_LIFETIME = 60 * 60 * 24 * 30;      // 30 days for students
const MAGIC_LIFETIME   = 60 * 30;                // 30 min for magic links

// ─────────────────────────────────────────────────────────────
// JWT-ish signed tokens
// ─────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s) {
  return Buffer.from(s, 'base64url');
}

/**
 * Sign a payload. Returns a string like "eyJhbGc..." that goes
 * straight into a cookie.
 */
export function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig  = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify a signed token. Returns the payload if valid + not expired,
 * else null. Constant-time signature comparison prevents timing
 * attacks that could leak HMAC bytes one at a time.
 */
export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(fromB64url(body).toString());
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Cookies
// ─────────────────────────────────────────────────────────────

/**
 * Build a Set-Cookie header for a session.
 * Pass null token to clear the cookie (logout).
 */
export function sessionCookieHeader(token, lifetimeSec = SESSION_LIFETIME) {
  if (token === null) {
    return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  }
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${lifetimeSec}`;
}

export function readCookie(headers, name) {
  const raw = headers.cookie || headers.Cookie || '';
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

/**
 * Pull the active session from the request. Returns the payload
 * (with .kind, .email, .personId, .cohortId, ...) or null if no
 * valid session.
 */
export function getSession(event) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const token = readCookie(event.headers, SESSION_COOKIE);
  return verifyToken(token, secret);
}

export function newSessionToken({ kind, email, personId, cohortId, role }, lifetimeSec) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return signToken(
    {
      kind, email, personId, cohortId, role,
      exp: Math.floor(Date.now() / 1000) + lifetimeSec,
      jti: randomBytes(8).toString('hex'),
    },
    secret
  );
}

export const TOKEN_LIFETIMES = {
  organiser: SESSION_LIFETIME,
  student:   STUDENT_LIFETIME,
};

// ─────────────────────────────────────────────────────────────
// Magic-link tokens
// ─────────────────────────────────────────────────────────────

/**
 * Make a new magic-link token. Returns { token, tokenHash }. We
 * store the hash; we email the token. They never coexist outside
 * this function.
 */
export function newMagicToken() {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return { token, tokenHash, expiresAt: new Date(Date.now() + MAGIC_LIFETIME * 1000) };
}

export function hashMagicToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// Organiser password hashing (scrypt, no external dep)
// ─────────────────────────────────────────────────────────────
//
// scrypt is built into Node, so we get a real password hash without
// pulling in bcrypt as a native dep (which has been a pain on
// Netlify in the past — different glibc versions etc.).
//
// Storage format: "scrypt$N$r$p$salt$hash" where salt and hash are
// base64. N=16384, r=8, p=1 is the OWASP-recommended baseline as of
// 2026.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(plaintext) {
  const salt = randomBytes(16);
  const hash = await scrypt(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(plaintext, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = parseInt(nStr, 10), r = parseInt(rStr, 10), p = parseInt(pStr, 10);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const computed = await scrypt(plaintext, salt, expected.length, { N, r, p });
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}
