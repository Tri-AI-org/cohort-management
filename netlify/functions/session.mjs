/**
 * session.mjs — who's signed in, plus signout.
 *
 * GET  /api/session    → { kind, email, cohortId?, role? } or 401
 * DELETE /api/session  → clears the cookie
 *
 * Used by AppShell.astro to populate the top bar and enforce
 * client-side role gates. Server-side gating still happens on
 * every API endpoint (the page is just a hint; the data is the
 * truth) so a tampered client can't actually see anything it
 * shouldn't.
 */

import { getSession, sessionCookieHeader } from './_lib/auth.mjs';
import { json, preflight, CORS, requireEnv } from './_lib/http.mjs';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  const envCheck = requireEnv(['SESSION_SECRET']);
  if (envCheck) return envCheck;

  if (event.httpMethod === 'GET') {
    const session = getSession(event);
    if (!session) return json(401, { kind: null });
    return json(200, {
      kind:     session.kind,
      email:    session.email,
      cohortId: session.cohortId,
      role:     session.role,
    });
  }

  if (event.httpMethod === 'DELETE') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS,
                 'Set-Cookie': sessionCookieHeader(null) },
      body: JSON.stringify({ ok: true }),
    };
  }

  return json(405, { error: 'Method not allowed' });
};
