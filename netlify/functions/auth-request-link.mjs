/**
 * auth-request-link.mjs
 *
 * Students and facilitators sign in by entering their email here.
 * If the email matches an active enrolment for any cohort, we:
 *   1. generate a one-time token
 *   2. store the hash in magic_link_tokens
 *   3. email the link to them
 *
 * The response is ALWAYS 200 OK with a generic "If your email is
 * enrolled, you'll receive a link" message — regardless of whether
 * we actually found the enrolment. This prevents the endpoint from
 * leaking who is enrolled (the same enumeration concern that
 * applied to the original Apps Script verify).
 *
 * Rate limited at 3 requests per email per 15 minutes. Beyond that
 * the function pretends to succeed but doesn't email — students
 * spamming the form won't generate a torrent of mail.
 */

import { query }            from './_lib/db.mjs';
import { newMagicToken }    from './_lib/auth.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  rateLimit, getClientIp, audit,
} from './_lib/http.mjs';

const GENERIC_OK = {
  ok: true,
  message: 'If your email is enrolled, a sign-in link has been sent. Check your inbox in the next minute.',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv([
    'DATABASE_URL', 'SESSION_SECRET', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PORTAL_BASE_URL',
  ]);
  if (envCheck) return envCheck;

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  // Normalise email at the boundary so every downstream comparison
  // is apples-to-apples. citext on the column makes this redundant
  // at the DB layer but explicit at the app layer is good hygiene.
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }

  const cohortNumber = body.cohort ? Number(body.cohort) : null;

  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  // Two rate limits: per IP (a script firing the same form), and
  // per email (a confused user clicking "send link" repeatedly).
  if (!rateLimit(`magic-ip:${ip}`,     10, 60 * 15)) return json(200, GENERIC_OK);
  if (!rateLimit(`magic-em:${email}`,  3,  60 * 15)) return json(200, GENERIC_OK);

  // Does this email belong to an active enrolment in any cohort?
  // We optionally scope to the specific cohort the student is on.
  const enrolment = await query(
    `SELECT e.id, e.cohort_id, e.role, p.first_name, p.last_name, c.number AS cohort_number
       FROM enrolments e
       JOIN people p   ON p.id = e.person_id
       JOIN cohorts c  ON c.id = e.cohort_id
      WHERE p.email = $1
        AND e.status = 'active'
        AND ($2::int IS NULL OR c.number = $2::int)
      ORDER BY c.number DESC
      LIMIT 1`,
    [email, cohortNumber]
  );

  if (enrolment.length === 0) {
    // No enrolment — return the generic success message anyway, so
    // an attacker can't tell apart "this email is on a cohort" from
    // "this email is not". Log the miss to audit so we have a record
    // of what was tried.
    await audit({
      action: 'magic_link_no_match',
      actorEmail: email,
      actorKind: 'student',
      ip, userAgent: ua,
    });
    return json(200, GENERIC_OK);
  }

  const row = enrolment[0];
  const { token, tokenHash, expiresAt } = newMagicToken();

  await query(
    `INSERT INTO magic_link_tokens
       (token_hash, email, cohort_id, expires_at, request_ip, request_ua)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tokenHash, email, row.cohort_id, expiresAt, ip, ua]
  );

  // The link goes to /auth/callback?t=<token>. The callback exchanges
  // it for a session cookie and redirects to the right destination.
  const link = `${process.env.PORTAL_BASE_URL.replace(/\/$/, '')}/auth/callback?t=${encodeURIComponent(token)}`;

  const firstName = row.first_name || email.split('@')[0];
  const { text, html } = renderEmail({
    heading: `Sign in to your Cohort ${row.cohort_number} portal`,
    paragraphs: [
      `Hi ${firstName},`,
      `Use the button below to sign in. The link is valid for 30 minutes and can only be used once.`,
      `If you didn't request this, ignore this email — your account is safe.`,
    ],
    cta: { label: 'Sign in →', url: link },
    footer: `Trouble with the button? Paste this URL into your browser:\n${link}`,
  });

  try {
    await sendMail({
      to: email,
      subject: `Sign in to your Cohort ${row.cohort_number} portal`,
      text, html,
    });
  } catch (err) {
    // Don't bubble email errors to the user — they would conclude
    // "the form is broken" when it's actually a transient SMTP issue.
    // We log + audit and the user sees the generic message; they can
    // re-request in a minute.
    console.error('magic-link email send failed:', err.message);
    await audit({
      action: 'magic_link_email_failed',
      actorEmail: email, ip, userAgent: ua,
      payload: { error: err.message },
    });
  }

  await audit({
    action: 'magic_link_sent',
    actorEmail: email, actorKind: row.role === 'facilitator' ? 'facilitator' : 'student',
    cohortId: row.cohort_id, targetType: 'enrolment', targetId: row.id,
    ip, userAgent: ua,
  });

  return json(200, GENERIC_OK);
};
