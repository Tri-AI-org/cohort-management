/**
 * dashboard-api.mjs
 *
 * The organiser dashboard reads everything through here. Replaces
 * the cohort-api proxy actions: overview, atrisk, students,
 * weekdetail, feedback.
 *
 * Organiser-only. All queries scoped to the cohort the organiser
 * explicitly names in the request — there's no implicit "current
 * cohort" because organisers monitor more than one at a time.
 */

import { query, queryOne } from './_lib/db.mjs';
import { getSession }      from './_lib/auth.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
} from './_lib/http.mjs';

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

  const cohortNumber = Number(body.cohort);
  if (!cohortNumber) return json(400, { error: 'cohort is required' });

  const cohort = await queryOne(
    `SELECT id, number, status, start_date, end_date, partner, cert_attendance_pct,
            atrisk_warn_misses, atrisk_crit_misses
       FROM cohorts WHERE number = $1`,
    [cohortNumber]
  );
  if (!cohort) return json(404, { error: 'Cohort not found' });

  switch (body.action) {
    case 'overview':    return overview(cohort);
    case 'atrisk':      return atrisk(cohort);
    case 'students':    return students(body, cohort);
    case 'weekdetail':  return weekdetail(body, cohort);
    case 'feedback':    return feedback(body, cohort);
    case 'sessions':    return sessions(cohort);
    case 'applications_summary': return applicationsSummary(cohort);
    default:            return json(400, { error: 'Unknown action' });
  }
};

async function overview(cohort) {
  const summary = await queryOne(
    `SELECT * FROM cohort_overview WHERE cohort_id = $1`,
    [cohort.id]
  );
  const dropOff = await query(
    `SELECT week_number, session_date, topic, is_break,
            attended_live, watched_recording, missed, excused, eligible_students
       FROM session_drop_off
      WHERE cohort_id = $1
      ORDER BY week_number`,
    [cohort.id]
  );
  return json(200, {
    cohort: {
      number: cohort.number, status: cohort.status,
      startDate: cohort.start_date, endDate: cohort.end_date,
      partner: cohort.partner,
    },
    summary: summary || {
      active_students: 0, withdrawn_students: 0, facilitator_count: 0,
      avg_attendance_pct: null, critical_count: 0, warning_count: 0,
    },
    sessions: dropOff,
  });
}

async function atrisk(cohort) {
  const rows = await query(
    `SELECT s.enrolment_id, s.attendance_pct, s.missed_count, s.elapsed_sessions,
            s.risk_status, p.email, p.first_name, p.last_name, p.country
       FROM student_attendance_summary s
       JOIN enrolments e ON e.id = s.enrolment_id
       JOIN people p     ON p.id = e.person_id
      WHERE s.cohort_id = $1
        AND s.risk_status IN ('warning', 'critical')
      ORDER BY
        CASE s.risk_status WHEN 'critical' THEN 0 ELSE 1 END,
        s.missed_count DESC,
        p.first_name`,
    [cohort.id]
  );
  return json(200, { rows });
}

async function students({ search, filter, page = 1, pageSize = 50 }, cohort) {
  const limit  = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const offset = Math.max((parseInt(page, 10) - 1) * limit, 0);

  const params = [cohort.id];
  const where  = [`s.cohort_id = $1`];
  if (filter === 'critical' || filter === 'warning' || filter === 'ok') {
    params.push(filter); where.push(`s.risk_status = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where.push(`(p.email ILIKE $${params.length} OR p.first_name ILIKE $${params.length} OR p.last_name ILIKE $${params.length})`);
  }
  params.push(limit, offset);

  const rows = await query(
    `SELECT s.enrolment_id, s.attendance_pct, s.missed_count, s.attended_count,
            s.risk_status, p.email, p.first_name, p.last_name, p.country
       FROM student_attendance_summary s
       JOIN enrolments e ON e.id = s.enrolment_id
       JOIN people p     ON p.id = e.person_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.first_name, p.last_name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = await queryOne(
    `SELECT count(*)::int AS n
       FROM student_attendance_summary s
       JOIN enrolments e ON e.id = s.enrolment_id
       JOIN people p     ON p.id = e.person_id
      WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );

  return json(200, { rows, total: total.n, page, pageSize: limit });
}

async function weekdetail({ week, page = 1, pageSize = 50, search }, cohort) {
  const w = Number(week);
  if (!w) return json(400, { error: 'week is required' });

  const session = await queryOne(
    `SELECT * FROM sessions WHERE cohort_id = $1 AND week_number = $2`,
    [cohort.id, w]
  );
  if (!session) return json(404, { error: 'Session not found for that week' });

  const limit  = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const offset = Math.max((parseInt(page, 10) - 1) * limit, 0);

  const params = [cohort.id, session.id];
  const extra  = '';
  let whereExtra = '';
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    whereExtra = `AND (p.email ILIKE $${params.length} OR p.first_name ILIKE $${params.length} OR p.last_name ILIKE $${params.length})`;
  }
  params.push(limit, offset);

  // Left join attendance so we see students who haven't submitted yet.
  const rows = await query(
    `SELECT p.email, p.first_name, p.last_name,
            a.status, a.rating, a.feedback_positive, a.feedback_question,
            a.submitted_at, e.id AS enrolment_id
       FROM enrolments e
       JOIN people p ON p.id = e.person_id
       LEFT JOIN attendance a
              ON a.enrolment_id = e.id AND a.session_id = $2
      WHERE e.cohort_id = $1 AND e.role = 'student' AND e.status = 'active'
        ${whereExtra}
      ORDER BY p.first_name, p.last_name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return json(200, {
    session: {
      week:  session.week_number, date: session.session_date,
      topic: session.topic,       isBreak: session.is_break,
    },
    rows,
  });
}

async function feedback({ week }, cohort) {
  // If a week is given, just that week. Otherwise all weeks.
  const params = [cohort.id];
  let weekClause = '';
  if (week) { params.push(Number(week)); weekClause = 'AND s.week_number = $2'; }

  const rows = await query(
    `SELECT s.week_number, s.topic,
            a.rating, a.feedback_positive, a.feedback_question, a.status,
            a.submitted_at
       FROM attendance a
       JOIN sessions s    ON s.id = a.session_id
       JOIN enrolments e  ON e.id = a.enrolment_id
      WHERE e.cohort_id = $1 ${weekClause}
        AND (a.feedback_positive IS NOT NULL OR a.feedback_question IS NOT NULL OR a.rating IS NOT NULL)
      ORDER BY s.week_number DESC, a.submitted_at DESC`,
    params
  );

  // Aggregate stats per week for the chart at the top.
  const stats = await query(
    `SELECT s.week_number, s.topic,
            COUNT(*) FILTER (WHERE a.rating IS NOT NULL)              AS rating_count,
            ROUND(AVG(a.rating) FILTER (WHERE a.rating IS NOT NULL), 2) AS avg_rating
       FROM attendance a
       JOIN sessions s    ON s.id = a.session_id
       JOIN enrolments e  ON e.id = a.enrolment_id
      WHERE e.cohort_id = $1
      GROUP BY s.week_number, s.topic
      ORDER BY s.week_number`,
    [cohort.id]
  );

  return json(200, { rows, stats });
}

async function sessions(cohort) {
  const rows = await query(
    `SELECT s.id, s.week_number, s.session_date, s.topic, s.is_break,
            s.slides_url, s.notebook_url, s.recording_url, s.readings_url,
            s.materials_status,
            f.id AS facilitator_id,
            fp.first_name AS facilitator_first, fp.last_name AS facilitator_last, fp.email AS facilitator_email
       FROM sessions s
       LEFT JOIN enrolments f ON f.id = s.facilitator_id
       LEFT JOIN people fp    ON fp.id = f.person_id
      WHERE s.cohort_id = $1
      ORDER BY s.week_number`,
    [cohort.id]
  );
  return json(200, { rows });
}

async function applicationsSummary(cohort) {
  const counts = await query(
    `SELECT status, count(*)::int AS n
       FROM applications WHERE cohort_id = $1 GROUP BY status`,
    [cohort.id]
  );
  return json(200, {
    counts: Object.fromEntries(counts.map(r => [r.status, r.n])),
  });
}
