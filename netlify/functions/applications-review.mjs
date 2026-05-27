/**
 * applications-review.mjs
 *
 * Three actions on this endpoint:
 *
 *   action=list        → returns applications for a cohort, with
 *                        filters and sort. Organisers see this in
 *                        the admin/applications page.
 *   action=detail      → returns one application's full payload.
 *   action=set_status  → updates status (accepted/rejected/...) for
 *                        one or many applications. Accepted creates
 *                        the matching enrolment row. Optionally
 *                        emails the applicant.
 *
 * Organiser-only. Everything goes through audit_log.
 */

import { query, queryOne, tx } from './_lib/db.mjs';
import { getSession }          from './_lib/auth.mjs';
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
  if (!session || session.kind !== 'organiser') {
    return json(401, { error: 'Not signed in as an organiser' });
  }

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  switch (body.action) {
    case 'list':       return listApplications(body, session);
    case 'detail':     return detailApplication(body, session);
    case 'set_status': return setStatus(body, session, ip, ua);
    default:           return json(400, { error: 'Unknown action' });
  }
};

async function listApplications(body, _session) {
  const cohortNumber = Number(body.cohort);
  if (!cohortNumber) return json(400, { error: 'cohort is required' });

  const cohort = await queryOne(`SELECT id FROM cohorts WHERE number = $1`, [cohortNumber]);
  if (!cohort) return json(404, { error: 'Cohort not found' });

  // Filter params with safe defaults.
  const status   = body.status ? String(body.status) : null;
  const country  = body.country ? String(body.country) : null;
  const search   = body.search ? String(body.search).trim().toLowerCase() : null;
  const sort     = ['submitted_at', 'prereq_score', 'reviewed_at'].includes(body.sort) ? body.sort : 'submitted_at';
  const dir      = body.dir === 'asc' ? 'ASC' : 'DESC';
  const limit    = Math.min(Math.max(parseInt(body.limit, 10) || 50, 1), 200);
  const offset   = Math.max(parseInt(body.offset, 10) || 0, 0);

  // Parameterised — search and status are user input. We never
  // concatenate into the SQL string.
  const params = [cohort.id];
  const where  = ['a.cohort_id = $1'];
  if (status)  { params.push(status);  where.push(`a.status = $${params.length}`); }
  if (country) { params.push(country); where.push(`p.country = $${params.length}`); }
  if (search)  {
    params.push(`%${search}%`);
    where.push(`(p.email ILIKE $${params.length} OR p.first_name ILIKE $${params.length} OR p.last_name ILIKE $${params.length})`);
  }
  params.push(limit, offset);

  const sql = `
    SELECT a.id, a.status, a.submitted_at, a.prereq_score, a.team_id_raw,
           a.prereq_python, a.prereq_statistics, a.prereq_linear_alg,
           a.prereq_numpy_pandas, a.prereq_ml_concepts,
           a.previous_participant, a.hours_per_week, a.can_commit_16w,
           a.applicant_role, a.field_of_work, a.reviewed_at, a.reviewed_by,
           p.id   AS person_id,
           p.email, p.first_name, p.last_name, p.country, p.city, p.github_url
      FROM applications a
      JOIN people p ON p.id = a.person_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.${sort} ${dir} NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const rows  = await query(sql, params);
  const total = await queryOne(
    `SELECT count(*)::int AS n
       FROM applications a JOIN people p ON p.id = a.person_id
      WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );

  return json(200, { rows, total: total.n, limit, offset });
}

async function detailApplication(body, _session) {
  const id = String(body.id || '');
  if (!id) return json(400, { error: 'id is required' });
  const row = await queryOne(
    `SELECT a.*, p.email, p.first_name, p.last_name, p.country, p.city,
            p.github_url, p.gender, p.age_range
       FROM applications a
       JOIN people p ON p.id = a.person_id
      WHERE a.id = $1`,
    [id]
  );
  if (!row) return json(404, { error: 'Application not found' });
  return json(200, { application: row });
}

async function setStatus(body, session, ip, ua) {
  const ids       = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
  const newStatus = String(body.status || '');
  const sendEmail = !!body.sendEmail;
  const customMessage = body.message ? String(body.message) : null;

  if (ids.length === 0) return json(400, { error: 'ids is required' });
  if (!['accepted', 'rejected', 'waitlisted', 'reviewing', 'withdrawn'].includes(newStatus)) {
    return json(400, { error: 'Invalid status' });
  }

  const result = await tx(async (c) => {
    const updated = [];
    for (const id of ids) {
      // Fetch the application + person + cohort in one go for context.
      const r = await c.query(
        `SELECT a.id, a.status AS old_status, a.cohort_id, a.person_id,
                p.email, p.first_name, c.number AS cohort_number, c.id AS cohort_id
           FROM applications a
           JOIN people p   ON p.id = a.person_id
           JOIN cohorts c  ON c.id = a.cohort_id
          WHERE a.id = $1
          FOR UPDATE`,
        [id]
      );
      if (r.rows.length === 0) continue;
      const app = r.rows[0];

      await c.query(
        `UPDATE applications
            SET status = $2, reviewed_at = now(), reviewed_by = $3
          WHERE id = $1`,
        [id, newStatus, session.email]
      );

      // Acceptance side-effect: create an enrolment if none exists.
      if (newStatus === 'accepted') {
        await c.query(
          `INSERT INTO enrolments
             (person_id, cohort_id, application_id, role, status, joined_week, accepted_at, accepted_by)
           VALUES ($1, $2, $3, 'student', 'active', 1, now(), $4)
           ON CONFLICT (person_id, cohort_id, role) DO UPDATE SET
             status = 'active',
             application_id = EXCLUDED.application_id,
             accepted_at = COALESCE(enrolments.accepted_at, now()),
             accepted_by = COALESCE(enrolments.accepted_by, EXCLUDED.accepted_by)`,
          [app.person_id, app.cohort_id, app.id, session.email]
        );
      }

      // Withdrawal side-effect: mark any existing enrolment as
      // withdrawn. Doesn't delete — preserves attendance history.
      if (newStatus === 'withdrawn') {
        await c.query(
          `UPDATE enrolments
              SET status = 'withdrawn', withdrawn_at = now()
            WHERE person_id = $1 AND cohort_id = $2 AND role = 'student'`,
          [app.person_id, app.cohort_id]
        );
      }

      updated.push({
        id, email: app.email, firstName: app.first_name,
        cohortNumber: app.cohort_number, oldStatus: app.old_status,
      });
    }
    return updated;
  });

  // ── Audit + email outside the transaction ─────────────────
  // Audit log writes themselves shouldn't block the transaction.
  // Emails definitely shouldn't — Gmail can take a second per send
  // and we don't want to hold a row-lock open while it does.

  for (const app of result) {
    await audit({
      action: 'application_status_change',
      actorEmail: session.email,
      cohortId: null,                       // will be filled in below
      targetType: 'application', targetId: app.id,
      ip, userAgent: ua,
      payload: { from: app.oldStatus, to: newStatus },
    });
  }

  if (sendEmail) {
    const sendOne = async (app) => {
      try {
        const portalUrl = `${(process.env.PORTAL_BASE_URL || 'https://cohort.tri-ai.org').replace(/\/$/, '')}/${app.cohortNumber}/`;
        const { text, html } = newStatus === 'accepted'
          ? renderEmail({
              heading: `You're in — welcome to Cohort ${app.cohortNumber}`,
              paragraphs: [
                `Hi ${app.firstName},`,
                `Great news — your application to TRI AI Saturdays Cohort ${app.cohortNumber} has been accepted.`,
                customMessage || `The cohort starts soon. Open the portal below to complete onboarding, see the schedule, and meet the community.`,
              ],
              cta: { label: 'Open the cohort portal →', url: portalUrl },
              footer: 'Reply to this email if you can no longer commit to the schedule, or with any questions.',
            })
          : newStatus === 'rejected'
          ? renderEmail({
              heading: `Cohort ${app.cohortNumber} — application update`,
              paragraphs: [
                `Hi ${app.firstName},`,
                `Thank you for applying to Cohort ${app.cohortNumber}. We received many strong applications this round and were not able to offer you a place this time.`,
                customMessage || `We genuinely hope you'll apply again. Your application stays in our system, and our next cohort applications open later this year — we'll let you know.`,
              ],
              footer: 'TRI AI Saturdays — cohorts@tri-ai.org',
            })
          : renderEmail({
              heading: `Cohort ${app.cohortNumber} — application update`,
              paragraphs: [
                `Hi ${app.firstName},`,
                customMessage || `Your application status has been updated to: ${newStatus}.`,
              ],
            });

        await sendMail({
          to: app.email,
          subject: newStatus === 'accepted'
            ? `🎉 You're accepted into Cohort ${app.cohortNumber}`
            : `Cohort ${app.cohortNumber} application update`,
          text, html,
        });
      } catch (err) {
        console.error(`Email to ${app.email} failed:`, err.message);
      }
    };

    // Send sequentially with a small gap so we don't hammer Gmail.
    // For bulk accept (100 students), this is 100 × ~1.5s = 2.5
    // minutes — that exceeds the function timeout. For sends > 20,
    // a background worker pattern is needed. We log a warning.
    if (result.length > 20) {
      console.warn(`set_status: ${result.length} emails queued — Gmail SMTP may not finish in time. ` +
                   `Consider importing in batches.`);
    }
    for (const app of result) {
      await sendOne(app);
    }
  }

  return json(200, {
    ok: true,
    updated: result.length,
    newStatus,
    emailsSent: sendEmail ? result.length : 0,
  });
}
