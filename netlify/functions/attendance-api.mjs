/**
 * attendance-api.mjs
 *
 * The two actions students hit weekly:
 *
 *   action=verify  — given an email + week, returns whether the
 *                    email is enrolled. Anonymous endpoint, rate
 *                    limited.
 *
 *   action=submit  — records attendance + feedback for a (student,
 *                    session). Idempotent: re-submitting overwrites
 *                    the existing row. Source = 'self'.
 *
 * Verifying is anonymous on purpose — students arrive on Saturday,
 * don't necessarily have an active session cookie, and shouldn't
 * need to magic-link in just to mark attendance. The audit trail
 * captures the IP and we rate-limit aggressively.
 */

import { query, queryOne } from './_lib/db.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  rateLimit, getClientIp, audit,
} from './_lib/http.mjs';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['DATABASE_URL']);
  if (envCheck) return envCheck;

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  switch (body.action) {
    case 'verify': return verify(body, ip, ua);
    case 'submit': return submit(body, ip, ua);
    default:       return json(400, { error: 'Unknown action' });
  }
};

async function verify(body, ip, ua) {
  // 5 attempts per IP per minute. Also 10 per email per hour, in
  // case someone tries to enumerate from many IPs but always for
  // the same target. (The audit log is the real defence; this is
  // the friction layer.)
  if (!rateLimit(`verify-ip:${ip}`, 5, 60))
    return json(429, { error: 'Too many attempts. Wait a minute.' });

  const email = String(body.email || '').trim().toLowerCase();
  const cohortNumber = Number(body.cohort);
  const week = Number(body.week);

  if (!email || !cohortNumber || !week) {
    return json(400, { error: 'email, cohort and week are required' });
  }

  if (!rateLimit(`verify-em:${email}`, 10, 60 * 60))
    return json(429, { error: 'Too many attempts. Try again later.' });

  // Look up the active student enrolment for this email in this cohort.
  const e = await queryOne(
    `SELECT e.id AS enrolment_id, p.first_name, p.last_name,
            c.id AS cohort_id, s.id AS session_id, s.is_break
       FROM people p
       JOIN enrolments e ON e.person_id = p.id
       JOIN cohorts c    ON c.id = e.cohort_id
       LEFT JOIN sessions s
              ON s.cohort_id = c.id AND s.week_number = $3
      WHERE p.email = $1
        AND c.number = $2
        AND e.role = 'student'
        AND e.status = 'active'
        AND $3 BETWEEN e.joined_week AND COALESCE(e.left_week, 999)`,
    [email, cohortNumber, week]
  );

  if (!e) {
    await audit({
      action: 'attendance_verify_no_match',
      actorEmail: email, actorKind: 'student',
      ip, userAgent: ua,
      payload: { cohort: cohortNumber, week },
    });
    return json(200, {
      valid: false,
      message: 'This email is not registered as an active student in this cohort. Please check the address, or email cohorts@tri-ai.org.',
    });
  }

  if (e.is_break) {
    return json(200, {
      valid: false,
      message: 'This is the mid-cohort break week — no session, no check-in needed.',
    });
  }

  // Has this person already submitted for this session?
  const existing = await queryOne(
    `SELECT id FROM attendance
      WHERE enrolment_id = $1 AND session_id = $2`,
    [e.enrolment_id, e.session_id]
  );

  return json(200, {
    valid: true,
    firstName: e.first_name,
    lastName:  e.last_name,
    name: `${e.first_name || ''} ${e.last_name || ''}`.trim() || email,
    alreadySubmitted: !!existing,
  });
}

async function submit(body, ip, ua) {
  if (!rateLimit(`submit-ip:${ip}`, 6, 60))
    return json(429, { error: 'Too many submissions. Wait a minute.' });

  const email        = String(body.email || '').trim().toLowerCase();
  const cohortNumber = Number(body.cohort);
  const week         = Number(body.week);
  const status       = String(body.attended || '');
  const rating       = body.rating ? Number(body.rating) : null;
  const fbPositive   = String(body.feedback1 || '').trim() || null;
  const fbQuestion   = String(body.feedback2 || '').trim() || null;

  if (!email || !cohortNumber || !week)
    return json(400, { error: 'email, cohort and week are required' });
  if (!['live', 'recording', 'missed'].includes(status))
    return json(400, { error: 'Invalid attendance status' });
  if (rating !== null && (rating < 1 || rating > 5))
    return json(400, { error: 'Rating must be 1-5' });

  // Resolve enrolment + session in one query.
  const ctx = await queryOne(
    `SELECT e.id AS enrolment_id, s.id AS session_id, c.id AS cohort_id, s.is_break
       FROM people p
       JOIN enrolments e ON e.person_id = p.id
       JOIN cohorts c    ON c.id = e.cohort_id
       JOIN sessions s   ON s.cohort_id = c.id AND s.week_number = $3
      WHERE p.email = $1 AND c.number = $2
        AND e.role = 'student' AND e.status = 'active'
        AND $3 BETWEEN e.joined_week AND COALESCE(e.left_week, 999)`,
    [email, cohortNumber, week]
  );

  if (!ctx) {
    return json(404, { error: 'No active enrolment found for that email + cohort + week.' });
  }
  if (ctx.is_break) {
    return json(400, { error: 'This is the break week — no attendance to record.' });
  }

  // Upsert.
  await query(
    `INSERT INTO attendance
       (enrolment_id, session_id, status, rating, feedback_positive, feedback_question, source, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'self', now())
     ON CONFLICT (enrolment_id, session_id) DO UPDATE SET
       status            = EXCLUDED.status,
       rating            = EXCLUDED.rating,
       feedback_positive = EXCLUDED.feedback_positive,
       feedback_question = EXCLUDED.feedback_question,
       submitted_at      = now(),
       updated_at        = now()`,
    [ctx.enrolment_id, ctx.session_id, status, rating, fbPositive, fbQuestion]
  );

  await audit({
    action: 'attendance_submitted',
    actorEmail: email, actorKind: 'student',
    cohortId: ctx.cohort_id,
    targetType: 'attendance', targetId: ctx.enrolment_id,
    ip, userAgent: ua,
    payload: { week, status, hasRating: !!rating },
  });

  return json(200, { ok: true });
}
