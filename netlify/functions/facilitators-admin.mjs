/**
 * facilitators-admin.mjs
 *
 * Manages the facilitator roster of a cohort.
 *
 * Permission model:
 *   - Organisers can do everything on every cohort
 *   - Lead facilitators (enrolments.is_lead=true) can manage
 *     facilitators on their own cohort only, with one exception:
 *     a lead can NOT demote another lead. (Prevents lock-out wars.
 *     Only organisers can demote leads.)
 *
 * Actions:
 *   list           → roster of facilitators on a cohort
 *   add            → create person+enrolment, send onboarding email
 *   remove         → set enrolment.status = 'withdrawn'. Doesn't
 *                    delete because audit trail.
 *   resend_invite  → re-send the onboarding email
 *   promote_lead   → set is_lead=true (organiser only)
 *   demote_lead    → set is_lead=false (organiser only)
 *
 * The onboarding email contains a magic-link signin so the
 * facilitator doesn't need to know about /signin or magic-link
 * mechanics — they just click and they're in.
 */

import { query, queryOne } from './_lib/db.mjs';
import { getSession, newMagicToken } from './_lib/auth.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  getClientIp, audit,
} from './_lib/http.mjs';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['DATABASE_URL', 'SESSION_SECRET']);
  if (envCheck) return envCheck;

  const session = getSession(event);
  if (!session) return json(401, { error: 'Not signed in' });
  if (session.kind !== 'organiser' && session.kind !== 'facilitator') {
    return json(403, { error: 'Organisers and lead facilitators only' });
  }

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const cohortNumber = Number(body.cohort);
  if (!cohortNumber) return json(400, { error: 'cohort is required' });

  const cohort = await queryOne(`SELECT id FROM cohorts WHERE number = $1`, [cohortNumber]);
  if (!cohort) return json(404, { error: 'Cohort not found' });

  // For facilitators: verify they're a LEAD on THIS cohort.
  // For organisers: pass.
  let isLead = false;
  if (session.kind === 'facilitator') {
    const myEnrolment = await queryOne(
      `SELECT e.is_lead FROM enrolments e
         JOIN people p ON p.id = e.person_id
        WHERE p.email = $1 AND e.cohort_id = $2
          AND e.role = 'facilitator' AND e.status = 'active'`,
      [session.email, cohort.id]
    );
    if (!myEnrolment || !myEnrolment.is_lead) {
      return json(403, { error: 'You are not a lead facilitator on this cohort.' });
    }
    isLead = true;
  }

  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  switch (body.action) {
    case 'list':          return list(cohort, cohortNumber);
    case 'add':           return add(cohort, cohortNumber, body, session, ip, ua);
    case 'remove':        return remove(cohort, cohortNumber, body, session, isLead, ip, ua);
    case 'resend_invite': return resendInvite(cohort, cohortNumber, body, session, ip, ua);
    case 'promote_lead':  return promoteLead(cohort, cohortNumber, body, session, isLead, ip, ua, true);
    case 'demote_lead':   return promoteLead(cohort, cohortNumber, body, session, isLead, ip, ua, false);
    default:              return json(400, { error: 'Unknown action' });
  }
};

async function list(cohort, cohortNumber) {
  const rows = await query(
    `SELECT e.id AS enrolment_id, e.role, e.status, e.is_lead,
            e.accepted_at, e.accepted_by,
            p.id AS person_id, p.email, p.first_name, p.last_name,
            p.country, p.github_url,
            (SELECT COUNT(*) FROM sessions s WHERE s.facilitator_id = e.id) AS sessions_assigned
       FROM enrolments e
       JOIN people p ON p.id = e.person_id
      WHERE e.cohort_id = $1 AND e.role = 'facilitator'
      ORDER BY e.is_lead DESC, p.first_name, p.last_name`,
    [cohort.id]
  );
  return json(200, { facilitators: rows, cohort: { number: cohortNumber, id: cohort.id } });
}

async function add(cohort, cohortNumber, body, session, ip, ua) {
  const email     = String(body.email || '').trim().toLowerCase();
  const firstName = body.first_name ? String(body.first_name).trim() : '';
  const lastName  = body.last_name  ? String(body.last_name).trim()  : '';
  const asLead    = !!body.as_lead;

  if (!email || !email.includes('@')) {
    return json(400, { error: 'A valid email is required' });
  }
  // Lead facilitators can add, but not as_lead — only organisers can mint a new lead
  if (asLead && session.kind !== 'organiser') {
    return json(403, { error: 'Only organisers can create a lead facilitator.' });
  }

  // Upsert person row
  await query(
    `INSERT INTO people (email, first_name, last_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET
       first_name = CASE WHEN people.first_name = people.email::text THEN EXCLUDED.first_name ELSE people.first_name END,
       last_name  = CASE WHEN people.last_name  = '' THEN EXCLUDED.last_name  ELSE people.last_name END`,
    [email, firstName || email, lastName]
  );
  const person = await queryOne(`SELECT id, first_name FROM people WHERE email = $1`, [email]);

  // Check existing enrolment on this cohort
  const existing = await queryOne(
    `SELECT id, status, is_lead FROM enrolments
      WHERE person_id = $1 AND cohort_id = $2 AND role = 'facilitator'`,
    [person.id, cohort.id]
  );

  let enrolmentId;
  if (existing) {
    if (existing.status === 'active') {
      return json(409, { error: 'This person is already a facilitator on this cohort.' });
    }
    // Re-activate
    await query(
      `UPDATE enrolments SET status = 'active', is_lead = $2 WHERE id = $1`,
      [existing.id, asLead]
    );
    enrolmentId = existing.id;
  } else {
    const created = await queryOne(
      `INSERT INTO enrolments (person_id, cohort_id, role, status, is_lead, accepted_at, accepted_by)
       VALUES ($1, $2, 'facilitator', 'active', $3, now(), $4)
       RETURNING id`,
      [person.id, cohort.id, asLead, session.email]
    );
    enrolmentId = created.id;
  }

  // Send the onboarding email (best-effort; don't fail the create on email failure)
  let emailSent = false;
  try {
    await sendOnboardingEmail({ email, firstName: person.first_name, cohortNumber, asLead });
    emailSent = true;
  } catch (err) {
    console.error('Onboarding email failed:', err.message);
  }

  await audit({
    action:     'facilitator_added',
    actorEmail: session.email,
    actorKind:  session.kind,
    cohortId:   cohort.id,
    targetType: 'enrolment', targetId: enrolmentId,
    ip, userAgent: ua,
    payload:    { email, as_lead: asLead, email_sent: emailSent },
  });

  return json(200, { ok: true, enrolmentId, emailSent });
}

async function remove(cohort, cohortNumber, body, session, isLead, ip, ua) {
  const enrolmentId = String(body.enrolmentId || '');
  if (!enrolmentId) return json(400, { error: 'enrolmentId is required' });

  const target = await queryOne(
    `SELECT e.id, e.is_lead, p.email
       FROM enrolments e JOIN people p ON p.id = e.person_id
      WHERE e.id = $1 AND e.cohort_id = $2 AND e.role = 'facilitator'`,
    [enrolmentId, cohort.id]
  );
  if (!target) return json(404, { error: 'Facilitator not found in this cohort' });
  if (target.is_lead && session.kind !== 'organiser') {
    return json(403, { error: 'Only organisers can remove a lead facilitator.' });
  }

  // Soft-delete via status change; also unassign from any sessions.
  await query(`UPDATE enrolments SET status = 'withdrawn' WHERE id = $1`, [enrolmentId]);
  await query(`UPDATE sessions SET facilitator_id = NULL WHERE facilitator_id = $1`, [enrolmentId]);

  await audit({
    action:     'facilitator_removed',
    actorEmail: session.email, actorKind: session.kind,
    cohortId:   cohort.id,
    targetType: 'enrolment', targetId: enrolmentId,
    ip, userAgent: ua,
    payload:    { email: target.email },
  });

  return json(200, { ok: true });
}

async function resendInvite(cohort, cohortNumber, body, session, ip, ua) {
  const enrolmentId = String(body.enrolmentId || '');
  if (!enrolmentId) return json(400, { error: 'enrolmentId is required' });

  const target = await queryOne(
    `SELECT e.id, e.is_lead, p.email, p.first_name
       FROM enrolments e JOIN people p ON p.id = e.person_id
      WHERE e.id = $1 AND e.cohort_id = $2 AND e.role = 'facilitator'
        AND e.status = 'active'`,
    [enrolmentId, cohort.id]
  );
  if (!target) return json(404, { error: 'Active facilitator not found' });

  try {
    await sendOnboardingEmail({
      email: target.email, firstName: target.first_name,
      cohortNumber, asLead: target.is_lead,
    });
  } catch (err) {
    return json(500, { error: 'Could not send email: ' + err.message });
  }

  await audit({
    action: 'facilitator_invite_resent',
    actorEmail: session.email, actorKind: session.kind,
    cohortId: cohort.id,
    targetType: 'enrolment', targetId: enrolmentId,
    ip, userAgent: ua, payload: { email: target.email },
  });

  return json(200, { ok: true });
}

async function promoteLead(cohort, cohortNumber, body, session, isLead, ip, ua, promote) {
  if (session.kind !== 'organiser') {
    return json(403, { error: 'Only organisers can change lead status.' });
  }
  const enrolmentId = String(body.enrolmentId || '');
  if (!enrolmentId) return json(400, { error: 'enrolmentId is required' });

  const target = await queryOne(
    `SELECT id FROM enrolments
      WHERE id = $1 AND cohort_id = $2 AND role = 'facilitator' AND status = 'active'`,
    [enrolmentId, cohort.id]
  );
  if (!target) return json(404, { error: 'Active facilitator not found' });

  await query(`UPDATE enrolments SET is_lead = $2 WHERE id = $1`, [enrolmentId, promote]);

  await audit({
    action:     promote ? 'facilitator_promoted_lead' : 'facilitator_demoted_lead',
    actorEmail: session.email, actorKind: session.kind,
    cohortId:   cohort.id,
    targetType: 'enrolment', targetId: enrolmentId,
    ip, userAgent: ua,
  });

  return json(200, { ok: true });
}

/**
 * Send a welcome+signin email. Uses a magic token so the facilitator
 * lands signed in — they don't need to know about /signin.
 */
async function sendOnboardingEmail({ email, firstName, cohortNumber, asLead }) {
  const portalBase = (process.env.PORTAL_BASE_URL || 'https://cohort.tri-ai.org').replace(/\/$/, '');

  // Mint a 7-day magic-link token. The standard newMagicToken() returns
  // a 30-minute expiry, which is fine for a sign-in request but too
  // short for an onboarding email that might sit unopened for a few
  // days. We use newMagicToken for the cryptographic token, then
  // override the expiry on insert.
  const { token, tokenHash } = newMagicToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Look up the cohort id so we can scope the token (so it lands the
  // facilitator on the right cohort's pages).
  const cohort = await queryOne(`SELECT id FROM cohorts WHERE number = $1`, [cohortNumber]);

  await query(
    `INSERT INTO magic_link_tokens
       (token_hash, email, cohort_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [tokenHash, email, cohort?.id ?? null, expiresAt]
  );

  const signinUrl = `${portalBase}/api/auth/callback?token=${encodeURIComponent(token)}`;

  const greeting = firstName && !firstName.includes('@')
    ? firstName
    : 'there';

  const { text, html } = renderEmail({
    heading: asLead
      ? `You're a lead facilitator on Cohort ${cohortNumber}`
      : `You're a facilitator on Cohort ${cohortNumber}`,
    paragraphs: [
      `Hi ${greeting},`,
      asLead
        ? `You've been added as a lead facilitator for TRI AI Saturdays Cohort ${cohortNumber}. Lead facilitators can manage the facilitator roster on the cohort, in addition to teaching their own sessions.`
        : `You've been added as a facilitator for TRI AI Saturdays Cohort ${cohortNumber}. You'll teach one or more weeks and can submit slides, notebooks, and recording links through the portal.`,
      `Click below to sign in. The link works for 7 days; after that, sign in at ${portalBase}/signin with this email and we'll send a fresh one.`,
    ],
    cta: { label: 'Open the cohort portal →', url: signinUrl },
    footer: `If your name isn't right, you can update it from your profile once you sign in.`,
  });

  await sendMail({
    to: email,
    subject: asLead
      ? `You're a lead facilitator on Cohort ${cohortNumber}`
      : `You're teaching on Cohort ${cohortNumber}`,
    text, html,
  });
}
