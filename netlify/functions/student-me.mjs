/**
 * student-me.mjs
 *
 * Powers the /[number]/me page. Returns:
 *   - the signed-in student's basic info
 *   - their attendance summary (% to date, weeks attended, etc.)
 *   - their attendance history (week-by-week)
 *
 * Requires a student session cookie (set by auth-callback). Will
 * NOT return data for a different person — kind == 'student'
 * sessions can only see themselves.
 */

import { query, queryOne } from './_lib/db.mjs';
import { getSession }      from './_lib/auth.mjs';
import { json, preflight, parseJsonBody, requireEnv } from './_lib/http.mjs';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['DATABASE_URL', 'SESSION_SECRET']);
  if (envCheck) return envCheck;

  const session = getSession(event);
  if (!session || (session.kind !== 'student' && session.kind !== 'facilitator')) {
    return json(401, { error: 'Sign in via the link emailed to you.' });
  }

  const body = parseJsonBody(event) || {};
  const cohortNumber = Number(body.cohort);
  if (!cohortNumber) return json(400, { error: 'cohort is required' });

  // The session names a cohort it was issued for. We refuse to
  // serve any other cohort's data on this token — if the student
  // wants to see Cohort 9 they need to re-magic-link in for C9.
  const expectedCohort = await queryOne(
    `SELECT number FROM cohorts WHERE id = $1`,
    [session.cohortId]
  );
  if (!expectedCohort || expectedCohort.number !== cohortNumber) {
    return json(403, { error: 'Your session is for a different cohort. Please sign in again.' });
  }

  // Their summary row from the view.
  const summary = await queryOne(
    `SELECT s.attendance_pct, s.attended_count, s.missed_count, s.elapsed_sessions,
            s.countable_sessions, s.cert_attendance_pct, s.risk_status,
            p.first_name, p.last_name, p.email
       FROM student_attendance_summary s
       JOIN enrolments e ON e.id = s.enrolment_id
       JOIN people p     ON p.id = e.person_id
      WHERE p.email = $1 AND s.cohort_id = $2`,
    [session.email, session.cohortId]
  );

  if (!summary) {
    return json(404, { error: 'No active enrolment found for your account in this cohort.' });
  }

  // Week-by-week history.
  const weeks = await query(
    `SELECT s.week_number, s.session_date, s.topic, s.is_break,
            a.status, a.rating, a.feedback_positive, a.feedback_question, a.submitted_at
       FROM sessions s
       LEFT JOIN attendance a
              ON a.session_id = s.id
             AND a.enrolment_id = (
               SELECT e.id FROM enrolments e
                  JOIN people p ON p.id = e.person_id
                 WHERE p.email = $1 AND e.cohort_id = $2 AND e.role='student' AND e.status='active'
             )
      WHERE s.cohort_id = $2
      ORDER BY s.week_number`,
    [session.email, session.cohortId]
  );

  return json(200, {
    me: {
      name: `${summary.first_name || ''} ${summary.last_name || ''}`.trim() || session.email,
      email: summary.email,
    },
    summary: {
      attendancePct:        summary.attendance_pct,
      attendedCount:        summary.attended_count,
      missedCount:          summary.missed_count,
      elapsedSessions:      summary.elapsed_sessions,
      countableSessions:    summary.countable_sessions,
      certThreshold:        summary.cert_attendance_pct,
      riskStatus:           summary.risk_status,
      onTrackForCertificate: summary.attendance_pct !== null
        && summary.attendance_pct >= summary.cert_attendance_pct,
    },
    weeks,
  });
};
