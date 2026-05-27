/**
 * attendance-admin.mjs
 *
 * Organiser-facing actions for managing attendance on behalf of
 * students. The student-facing flow (self-submit via /check-in) is
 * unchanged and lives in attendance-api.mjs. This file is the
 * "manual override" surface organisers use when:
 *
 *   - A student emailed to say they were sick → mark 'excused'
 *   - Forgot to check in → mark them present manually
 *   - Live session ended and we want to bulk-mark "everyone here"
 *
 * Actions:
 *   mark      → set one student's attendance for one session
 *   bulk_mark → array of (enrolmentId, sessionId, status) — single tx
 *   unmark    → delete an attendance row (rare; for fix-ups)
 *
 * Every change writes source='organiser' to the attendance row and
 * an audit_log entry.
 */

import { query, queryOne, tx } from './_lib/db.mjs';
import { getSession }          from './_lib/auth.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  getClientIp, audit,
} from './_lib/http.mjs';

const VALID_STATUSES = ['live', 'recording', 'missed', 'excused'];

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['DATABASE_URL', 'SESSION_SECRET']);
  if (envCheck) return envCheck;

  const session = getSession(event);
  if (!session || session.kind !== 'organiser') {
    return json(401, { error: 'Not signed in as an organiser' });
  }

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  switch (body.action) {
    case 'mark':      return mark(body, session, ip, ua);
    case 'bulk_mark': return bulkMark(body, session, ip, ua);
    case 'unmark':    return unmark(body, session, ip, ua);
    case 'list':      return list(body);
    default:          return json(400, { error: 'Unknown action' });
  }
};

async function list(body) {
  // List of attendance for a given session, including students who
  // haven't been marked yet. Used by the week-detail admin page.
  const sessionId = String(body.sessionId || '');
  if (!sessionId) return json(400, { error: 'sessionId is required' });

  const sess = await queryOne(
    `SELECT s.id, s.cohort_id, s.week_number, s.topic, s.session_date, s.is_break
       FROM sessions s WHERE s.id = $1`, [sessionId]
  );
  if (!sess) return json(404, { error: 'Session not found' });

  const rows = await query(
    `SELECT e.id AS enrolment_id, p.first_name, p.last_name, p.email,
            a.status, a.rating, a.feedback_positive, a.feedback_question,
            a.source, a.submitted_at
       FROM enrolments e
       JOIN people p ON p.id = e.person_id
       LEFT JOIN attendance a
              ON a.enrolment_id = e.id AND a.session_id = $1
      WHERE e.cohort_id = $2
        AND e.role = 'student' AND e.status = 'active'
        AND $3 BETWEEN e.joined_week AND COALESCE(e.left_week, 999)
      ORDER BY p.first_name, p.last_name`,
    [sessionId, sess.cohort_id, sess.week_number]
  );

  return json(200, { session: sess, rows });
}

async function mark(body, session, ip, ua) {
  const enrolmentId = String(body.enrolmentId || '');
  const sessionId   = String(body.sessionId || '');
  const status      = String(body.status || '');

  if (!enrolmentId || !sessionId) {
    return json(400, { error: 'enrolmentId and sessionId are required' });
  }
  if (!VALID_STATUSES.includes(status)) {
    return json(400, { error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  await query(
    `INSERT INTO attendance (enrolment_id, session_id, status, source, submitted_at)
     VALUES ($1, $2, $3, 'organiser', now())
     ON CONFLICT (enrolment_id, session_id) DO UPDATE SET
       status       = EXCLUDED.status,
       source       = 'organiser',
       submitted_at = now(),
       updated_at   = now()`,
    [enrolmentId, sessionId, status]
  );

  // Look up cohort for audit
  const sess = await queryOne(`SELECT cohort_id, week_number FROM sessions WHERE id = $1`, [sessionId]);

  await audit({
    action:     'attendance_marked',
    actorEmail: session.email,
    cohortId:   sess?.cohort_id,
    targetType: 'attendance', targetId: enrolmentId,
    ip, userAgent: ua,
    payload:    { week: sess?.week_number, status },
  });

  return json(200, { ok: true });
}

async function bulkMark(body, session, ip, ua) {
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return json(400, { error: 'items array required' });

  for (const item of items) {
    if (!VALID_STATUSES.includes(item.status)) {
      return json(400, { error: `Invalid status: ${item.status}` });
    }
  }

  let count = 0;
  await tx(async (c) => {
    for (const item of items) {
      if (!item.enrolmentId || !item.sessionId) continue;
      await c.query(
        `INSERT INTO attendance (enrolment_id, session_id, status, source, submitted_at)
         VALUES ($1, $2, $3, 'organiser', now())
         ON CONFLICT (enrolment_id, session_id) DO UPDATE SET
           status       = EXCLUDED.status,
           source       = 'organiser',
           submitted_at = now(),
           updated_at   = now()`,
        [item.enrolmentId, item.sessionId, item.status]
      );
      count++;
    }
  });

  await audit({
    action:     'attendance_bulk_marked',
    actorEmail: session.email,
    ip, userAgent: ua,
    payload:    { count, sample_status: items[0]?.status },
  });

  return json(200, { ok: true, count });
}

async function unmark(body, session, ip, ua) {
  const enrolmentId = String(body.enrolmentId || '');
  const sessionId   = String(body.sessionId || '');
  if (!enrolmentId || !sessionId) {
    return json(400, { error: 'enrolmentId and sessionId are required' });
  }

  await query(
    `DELETE FROM attendance WHERE enrolment_id = $1 AND session_id = $2`,
    [enrolmentId, sessionId]
  );

  await audit({
    action:     'attendance_unmarked',
    actorEmail: session.email,
    targetType: 'attendance', targetId: enrolmentId,
    ip, userAgent: ua,
  });

  return json(200, { ok: true });
}
