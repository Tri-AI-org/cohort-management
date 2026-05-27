/**
 * facilitator-dashboard.mjs
 *
 * The facilitator's view of their own work in a cohort.
 *
 *   action=overview       → all sessions they lead, with materials status
 *   action=update_materials → submit/update slide/notebook URLs for a session
 *   action=feedback       → anonymised feedback for a given session they led
 *
 * Auth: requires a session with kind='facilitator' OR kind='organiser'
 * (organisers can see/edit on facilitators' behalf — useful when a
 * facilitator emails saying "I can't find the upload button").
 *
 * Scoping: a facilitator can only see/modify sessions where THEY are
 * the facilitator. The DB query joins on enrolment_id so this is
 * enforced at the SQL layer, not "trust the client".
 */

import { query, queryOne } from './_lib/db.mjs';
import { getSession }      from './_lib/auth.mjs';
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
  if (session.kind !== 'facilitator' && session.kind !== 'organiser') {
    return json(403, { error: 'Not a facilitator or organiser' });
  }

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const cohortNumber = Number(body.cohort);
  if (!cohortNumber) return json(400, { error: 'cohort is required' });

  const cohort = await queryOne(
    `SELECT id FROM cohorts WHERE number = $1`, [cohortNumber]
  );
  if (!cohort) return json(404, { error: 'Cohort not found' });

  // Resolve THIS facilitator's enrolment id, OR (for organisers acting
  // on behalf) the target enrolment id passed in.
  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  switch (body.action) {
    case 'overview':           return overview(session, cohort, body);
    case 'update_materials':   return updateMaterials(session, cohort, body, ip, ua);
    case 'feedback':           return feedback(session, cohort, body);
    default:                   return json(400, { error: 'Unknown action' });
  }
};

/**
 * Returns the sessions this facilitator leads in the given cohort.
 * For organisers: returns all sessions in the cohort.
 */
async function overview(session, cohort, _body) {
  if (session.kind === 'facilitator') {
    // Find this facilitator's enrolment id for this cohort
    const en = await queryOne(
      `SELECT e.id FROM enrolments e
         JOIN people p ON p.id = e.person_id
        WHERE p.email = $1 AND e.cohort_id = $2 AND e.role = 'facilitator' AND e.status = 'active'`,
      [session.email, cohort.id]
    );
    if (!en) {
      return json(403, { error: 'You are not a facilitator on this cohort.' });
    }

    const rows = await query(
      `SELECT s.id, s.week_number, s.session_date, s.topic, s.is_break,
              s.slides_url, s.notebook_url, s.recording_url, s.readings_url,
              s.materials_status, s.materials_notes
         FROM sessions s
        WHERE s.cohort_id = $1 AND s.facilitator_id = $2
        ORDER BY s.week_number`,
      [cohort.id, en.id]
    );
    return json(200, { sessions: rows, asOrganiser: false });
  }

  // Organiser view: all sessions
  const rows = await query(
    `SELECT s.id, s.week_number, s.session_date, s.topic, s.is_break,
            s.slides_url, s.notebook_url, s.recording_url, s.readings_url,
            s.materials_status, s.materials_notes,
            fp.first_name AS fac_first, fp.last_name AS fac_last, fp.email AS fac_email
       FROM sessions s
       LEFT JOIN enrolments fe ON fe.id = s.facilitator_id
       LEFT JOIN people fp     ON fp.id = fe.person_id
      WHERE s.cohort_id = $1
      ORDER BY s.week_number`,
    [cohort.id]
  );
  return json(200, { sessions: rows, asOrganiser: true });
}

/**
 * Update materials for a session. The facilitator can submit URLs
 * (slides, notebook, recording, readings) and a free-text note for
 * organisers. Status auto-transitions to 'submitted' on any change,
 * unless the change is being made by an organiser, in which case
 * the status is whatever they pass in.
 */
async function updateMaterials(session, cohort, body, ip, ua) {
  const sessionId = String(body.sessionId || '');
  if (!sessionId) return json(400, { error: 'sessionId is required' });

  // Look up the session and verify the caller can edit it.
  const sess = await queryOne(
    `SELECT s.id, s.facilitator_id, s.cohort_id, s.week_number, s.materials_status
       FROM sessions s WHERE s.id = $1`, [sessionId]
  );
  if (!sess) return json(404, { error: 'Session not found' });
  if (sess.cohort_id !== cohort.id) return json(400, { error: 'Session belongs to a different cohort' });

  // Facilitator-level access check
  if (session.kind === 'facilitator') {
    const en = await queryOne(
      `SELECT e.id FROM enrolments e
         JOIN people p ON p.id = e.person_id
        WHERE p.email = $1 AND e.cohort_id = $2 AND e.role = 'facilitator' AND e.status = 'active'`,
      [session.email, cohort.id]
    );
    if (!en || en.id !== sess.facilitator_id) {
      return json(403, { error: 'You do not lead this session.' });
    }
  }

  // Build the update. Only fields the caller explicitly sent are touched;
  // omitting a field leaves it unchanged.
  const updates = [];
  const params = [sessionId];
  const fields = ['slides_url', 'notebook_url', 'recording_url', 'readings_url'];

  for (const f of fields) {
    if (body[f] !== undefined) {
      params.push(body[f] === '' ? null : String(body[f]));
      updates.push(`${f} = $${params.length}`);
    }
  }
  if (body.materials_notes !== undefined) {
    params.push(String(body.materials_notes || ''));
    updates.push(`materials_notes = $${params.length}`);
  }

  // Status logic: organisers can set anything; facilitators always
  // get 'submitted' on any change.
  let newStatus = null;
  if (session.kind === 'organiser' && body.materials_status) {
    if (!['pending', 'submitted', 'approved', 'changes_requested'].includes(body.materials_status)) {
      return json(400, { error: 'Invalid materials_status' });
    }
    newStatus = body.materials_status;
  } else if (session.kind === 'facilitator' && updates.length > 0) {
    newStatus = 'submitted';
  }
  if (newStatus) {
    params.push(newStatus);
    updates.push(`materials_status = $${params.length}`);
  }

  if (updates.length === 0) {
    return json(400, { error: 'No fields to update' });
  }

  await query(`UPDATE sessions SET ${updates.join(', ')} WHERE id = $1`, params);

  await audit({
    action: 'materials_updated',
    actorEmail: session.email,
    actorKind:  session.kind,
    cohortId:   cohort.id,
    targetType: 'session', targetId: sessionId,
    ip, userAgent: ua,
    payload: { week: sess.week_number, newStatus, fields: Object.keys(body).filter(k => fields.includes(k) || k === 'materials_notes' || k === 'materials_status') },
  });

  return json(200, { ok: true, status: newStatus });
}

/**
 * Anonymised feedback for one session.
 * Returns ratings and free-text feedback; does NOT return student
 * names or emails. Facilitators can only fetch feedback for sessions
 * they led; organisers can fetch any session.
 */
async function feedback(session, cohort, body) {
  const sessionId = String(body.sessionId || '');
  if (!sessionId) return json(400, { error: 'sessionId is required' });

  const sess = await queryOne(
    `SELECT s.id, s.facilitator_id, s.cohort_id, s.week_number, s.topic
       FROM sessions s WHERE s.id = $1`, [sessionId]
  );
  if (!sess) return json(404, { error: 'Session not found' });
  if (sess.cohort_id !== cohort.id) return json(400, { error: 'Session belongs to a different cohort' });

  if (session.kind === 'facilitator') {
    const en = await queryOne(
      `SELECT e.id FROM enrolments e
         JOIN people p ON p.id = e.person_id
        WHERE p.email = $1 AND e.cohort_id = $2 AND e.role = 'facilitator' AND e.status = 'active'`,
      [session.email, cohort.id]
    );
    if (!en || en.id !== sess.facilitator_id) {
      return json(403, { error: 'You do not lead this session.' });
    }
  }

  // Aggregate stats first — this is what most facilitators want at a glance.
  const stats = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('live','recording'))    AS attended,
       COUNT(*) FILTER (WHERE status = 'missed')                 AS missed,
       COUNT(*) FILTER (WHERE rating IS NOT NULL)                AS rating_count,
       ROUND(AVG(rating)::numeric, 2) FILTER (WHERE rating IS NOT NULL) AS avg_rating
     FROM attendance WHERE session_id = $1`,
    [sessionId]
  );

  // Detail rows — anonymised. We return rating + free text only.
  // (We intentionally do not return the order rows were submitted in,
  // since that could be correlated to who attended live vs recording.)
  const rows = await query(
    `SELECT rating, feedback_positive, feedback_question, status
       FROM attendance
      WHERE session_id = $1
        AND (feedback_positive IS NOT NULL OR feedback_question IS NOT NULL OR rating IS NOT NULL)
      ORDER BY random()`,
    [sessionId]
  );

  return json(200, {
    session: {
      id: sess.id, week: sess.week_number, topic: sess.topic,
    },
    stats,
    feedback: rows,
  });
}
