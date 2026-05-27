/**
 * sessions-admin.mjs
 *
 * Bulk edit the schedule of a cohort. Actions:
 *
 *   list   → all sessions for a cohort (used to populate the edit UI)
 *   update → patch one session row by id
 *   bulk   → array of session patches, applied in a transaction
 *   assign_facilitator → set sessions.facilitator_id (looked up by
 *           the facilitator's email + cohort)
 *
 * Organiser-only. Every mutation goes through audit_log.
 */

import { query, queryOne, tx } from './_lib/db.mjs';
import { getSession }          from './_lib/auth.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  getClientIp, audit,
} from './_lib/http.mjs';

const SESSION_WRITABLE = ['session_date', 'topic', 'is_break', 'materials_notes'];

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
    case 'list':               return listSessions(body);
    case 'update':             return updateSession(body, session, ip, ua);
    case 'bulk':               return bulkUpdate(body, session, ip, ua);
    case 'assign_facilitator': return assignFacilitator(body, session, ip, ua);
    default:                   return json(400, { error: 'Unknown action' });
  }
};

async function listSessions({ cohort }) {
  const num = Number(cohort);
  if (!num) return json(400, { error: 'cohort is required' });
  const cohortRow = await queryOne(`SELECT id FROM cohorts WHERE number = $1`, [num]);
  if (!cohortRow) return json(404, { error: 'Cohort not found' });

  const rows = await query(
    `SELECT s.id, s.week_number, s.session_date, s.topic, s.is_break,
            s.slides_url, s.notebook_url, s.recording_url, s.readings_url,
            s.materials_status, s.materials_notes, s.facilitator_id,
            fp.first_name AS fac_first, fp.last_name AS fac_last, fp.email AS fac_email
       FROM sessions s
       LEFT JOIN enrolments fe ON fe.id = s.facilitator_id
       LEFT JOIN people fp     ON fp.id = fe.person_id
      WHERE s.cohort_id = $1
      ORDER BY s.week_number`,
    [cohortRow.id]
  );
  return json(200, { sessions: rows });
}

async function updateSession(body, session, ip, ua) {
  const id = String(body.id || '');
  if (!id) return json(400, { error: 'id is required' });

  const sess = await queryOne(`SELECT id, cohort_id, week_number FROM sessions WHERE id = $1`, [id]);
  if (!sess) return json(404, { error: 'Session not found' });

  const patch = body.fields || {};
  const updates = [];
  const params  = [id];
  for (const col of SESSION_WRITABLE) {
    if (!(col in patch)) continue;
    let val = patch[col];
    if (col === 'is_break') val = !!val;
    if (col === 'session_date' && val === '') val = null;
    params.push(val);
    updates.push(`${col} = $${params.length}`);
  }
  if (updates.length === 0) return json(400, { error: 'No editable fields' });

  await query(`UPDATE sessions SET ${updates.join(', ')} WHERE id = $1`, params);

  await audit({
    action:     'session_updated',
    actorEmail: session.email,
    cohortId:   sess.cohort_id,
    targetType: 'session', targetId: id,
    ip, userAgent: ua,
    payload:    { week: sess.week_number, fields: Object.keys(patch) },
  });

  return json(200, { ok: true });
}

async function bulkUpdate(body, session, ip, ua) {
  const sessions = Array.isArray(body.sessions) ? body.sessions : null;
  if (!sessions) return json(400, { error: 'sessions array required' });

  let updated = 0;
  await tx(async (c) => {
    for (const s of sessions) {
      if (!s.id) continue;
      const patch = s.fields || {};
      const updates = [];
      const params  = [s.id];
      for (const col of SESSION_WRITABLE) {
        if (!(col in patch)) continue;
        let val = patch[col];
        if (col === 'is_break') val = !!val;
        if (col === 'session_date' && val === '') val = null;
        params.push(val);
        updates.push(`${col} = $${params.length}`);
      }
      if (updates.length > 0) {
        await c.query(`UPDATE sessions SET ${updates.join(', ')} WHERE id = $1`, params);
        updated++;
      }
    }
  });

  await audit({
    action: 'sessions_bulk_updated', actorEmail: session.email,
    ip, userAgent: ua, payload: { updated },
  });

  return json(200, { ok: true, updated });
}

async function assignFacilitator(body, session, ip, ua) {
  const sessionId = String(body.sessionId || '');
  const email     = String(body.email || '').trim().toLowerCase();
  if (!sessionId) return json(400, { error: 'sessionId is required' });

  // If email is empty, clear the facilitator
  const sess = await queryOne(
    `SELECT id, cohort_id, week_number FROM sessions WHERE id = $1`, [sessionId]
  );
  if (!sess) return json(404, { error: 'Session not found' });

  let facilitatorId = null;

  if (email) {
    // Look up the facilitator's enrolment. Auto-promote them: if the
    // person exists but isn't enrolled as a facilitator, create the
    // enrolment automatically. Same person can become a facilitator
    // on multiple sessions in the same cohort.
    let enrolment = await queryOne(
      `SELECT e.id FROM enrolments e
         JOIN people p ON p.id = e.person_id
        WHERE p.email = $1 AND e.cohort_id = $2 AND e.role = 'facilitator'`,
      [email, sess.cohort_id]
    );

    if (!enrolment) {
      // Create the person if needed, then the facilitator enrolment.
      await query(
        `INSERT INTO people (email, first_name, last_name)
         VALUES ($1, $1, '')
         ON CONFLICT (email) DO NOTHING`,
        [email]
      );
      const person = await queryOne(`SELECT id FROM people WHERE email = $1`, [email]);
      const created = await queryOne(
        `INSERT INTO enrolments
           (person_id, cohort_id, role, status, accepted_at, accepted_by)
         VALUES ($1, $2, 'facilitator', 'active', now(), $3)
         RETURNING id`,
        [person.id, sess.cohort_id, session.email]
      );
      enrolment = created;
    }
    facilitatorId = enrolment.id;
  }

  await query(
    `UPDATE sessions SET facilitator_id = $2 WHERE id = $1`,
    [sessionId, facilitatorId]
  );

  await audit({
    action:     'facilitator_assigned',
    actorEmail: session.email,
    cohortId:   sess.cohort_id,
    targetType: 'session', targetId: sessionId,
    ip, userAgent: ua,
    payload:    { week: sess.week_number, facilitator_email: email || null },
  });

  return json(200, { ok: true });
}
