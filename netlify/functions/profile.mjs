/**
 * profile.mjs
 *
 * Self-service profile data:
 *   - get             → fetch own profile (or someone else's, organisers only)
 *   - update          → update self (limited fields), or anyone (organisers)
 *   - request_correction → student sends a "please fix X" email to organisers
 *
 * Permission model:
 *   Students: read-only on their own profile. Can submit a correction
 *             request that emails organisers (we don't auto-apply).
 *   Facilitators: read-only on their own profile EXCEPT first_name,
 *             last_name, github_url, country, city — they can edit
 *             these themselves because they were auto-created with
 *             email-as-name. Can also submit corrections for fields
 *             they can't edit.
 *   Organisers: can read and edit any profile.
 *
 * What's in the profile:
 *   - From `people` table: email, names, country, city, github_url,
 *     gender, age_range, programme_tags, notes (organiser-only)
 *   - From `enrolments`: their role + status in each cohort
 *   - From `applications`: snippets if they came via the form
 */

import { query, queryOne } from './_lib/db.mjs';
import { getSession }      from './_lib/auth.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  getClientIp, audit,
} from './_lib/http.mjs';

// Fields a facilitator can edit on themselves.
const FACILITATOR_EDITABLE = ['first_name', 'last_name', 'github_url', 'country', 'city'];
// Fields an organiser can edit on anyone.
const ORGANISER_EDITABLE   = ['first_name', 'last_name', 'github_url', 'country', 'city',
                              'gender', 'age_range', 'notes'];

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['DATABASE_URL', 'SESSION_SECRET']);
  if (envCheck) return envCheck;

  const session = getSession(event);
  if (!session) return json(401, { error: 'Not signed in' });

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  switch (body.action) {
    case 'get':                 return getProfile(session, body);
    case 'update':              return updateProfile(session, body, ip, ua);
    case 'request_correction':  return requestCorrection(session, body, ip, ua);
    default:                    return json(400, { error: 'Unknown action' });
  }
};

/**
 * Get a profile. If `email` is given AND the caller is an organiser,
 * fetch that profile. Otherwise fetch self.
 */
async function getProfile(session, body) {
  const targetEmail = body.email && session.kind === 'organiser'
    ? String(body.email).toLowerCase().trim()
    : session.email;

  const person = await queryOne(
    `SELECT id, email, first_name, last_name, country, city, github_url,
            gender, age_range, programme_tags,
            ${session.kind === 'organiser' ? 'notes,' : 'NULL AS notes,'}
            created_at
       FROM people WHERE email = $1`,
    [targetEmail]
  );
  if (!person) return json(404, { error: 'Profile not found' });

  // Enrolments (which cohorts, what role, what status)
  const enrolments = await query(
    `SELECT e.id, e.role, e.status, e.is_lead, e.joined_week, e.left_week,
            e.accepted_at,
            c.number AS cohort_number, c.title AS cohort_title, c.status AS cohort_status
       FROM enrolments e
       JOIN cohorts c ON c.id = e.cohort_id
      WHERE e.person_id = $1
      ORDER BY c.number DESC`,
    [person.id]
  );

  // What can the caller edit?
  let editable = [];
  const isSelf = targetEmail === session.email;
  if (session.kind === 'organiser') {
    editable = ORGANISER_EDITABLE;
  } else if (isSelf && session.kind === 'facilitator') {
    editable = FACILITATOR_EDITABLE;
  }
  // Students get no editable fields — they request corrections instead.

  return json(200, {
    person,
    enrolments,
    editable,
    isSelf,
    canRequestCorrection: isSelf,   // any signed-in user can request fixes to their own
  });
}

/**
 * Update a profile. Field whitelist depends on caller kind + target.
 */
async function updateProfile(session, body, ip, ua) {
  const targetEmail = body.email && session.kind === 'organiser'
    ? String(body.email).toLowerCase().trim()
    : session.email;
  const isSelf = targetEmail === session.email;

  // Determine whitelist
  let whitelist;
  if (session.kind === 'organiser') {
    whitelist = ORGANISER_EDITABLE;
  } else if (isSelf && session.kind === 'facilitator') {
    whitelist = FACILITATOR_EDITABLE;
  } else {
    return json(403, { error: 'You cannot edit this profile.' });
  }

  const person = await queryOne(`SELECT id FROM people WHERE email = $1`, [targetEmail]);
  if (!person) return json(404, { error: 'Profile not found' });

  const updates = [];
  const params  = [person.id];
  const fields  = body.fields || {};

  for (const col of whitelist) {
    if (!(col in fields)) continue;
    const val = fields[col] === '' ? null : String(fields[col]).trim();
    params.push(val);
    updates.push(`${col} = $${params.length}`);
  }
  if (updates.length === 0) return json(400, { error: 'No editable fields supplied' });

  await query(`UPDATE people SET ${updates.join(', ')} WHERE id = $1`, params);

  await audit({
    action:     'profile_updated',
    actorEmail: session.email,
    actorKind:  session.kind,
    targetType: 'person', targetId: person.id,
    ip, userAgent: ua,
    payload:    { target_email: targetEmail, fields: Object.keys(fields) },
  });

  return json(200, { ok: true });
}

/**
 * Student or facilitator submits "please fix X" — we email organisers
 * of any cohort they're enrolled in. No silent applications; the
 * organisers see the request and apply it (or not) through the admin
 * profile editor.
 */
async function requestCorrection(session, body, ip, ua) {
  const message = String(body.message || '').trim();
  if (!message) return json(400, { error: 'Tell us what should change.' });
  if (message.length > 2000) return json(400, { error: 'Keep the message under 2000 characters.' });

  const person = await queryOne(
    `SELECT id, first_name, last_name FROM people WHERE email = $1`,
    [session.email]
  );
  if (!person) return json(404, { error: 'No profile to correct.' });

  // Find every organiser of every cohort this person is enrolled in.
  const recipients = await query(
    `SELECT DISTINCT o.email
       FROM enrolments e
       JOIN cohorts c     ON c.id = e.cohort_id
       JOIN organisers o  ON o.is_active = true
      WHERE e.person_id = $1`,
    [person.id]
  );

  // Fall back to a hardcoded admin if no enrolment org link (rare)
  const toAddresses = recipients.length > 0
    ? recipients.map(r => r.email)
    : [process.env.ADMIN_EMAIL || 'cohorts@tri-ai.org'];

  // Log the request to audit_log so it's findable.
  await audit({
    action:     'profile_correction_requested',
    actorEmail: session.email,
    actorKind:  session.kind,
    targetType: 'person', targetId: person.id,
    ip, userAgent: ua,
    payload:    { message_preview: message.slice(0, 200) },
  });

  // Send the email. Don't block the response on email-send success;
  // log audit even if email fails so the request is recoverable.
  const subject = `[Cohort portal] Profile correction request from ${session.email}`;
  const { text, html } = renderEmail({
    heading: 'Profile correction request',
    paragraphs: [
      `${person.first_name || 'A user'} ${person.last_name || ''} (${session.email}) ` +
      `has requested a correction to their profile.`,
      `Their message:`,
      message,
      `To apply the change, open the admin tools and edit their profile, ` +
      `then reply directly to this email so they know.`,
    ],
    footer: 'Logged in the cohort portal audit log.',
  });

  let sentCount = 0;
  for (const to of toAddresses) {
    try {
      await sendMail({ to, subject, text, html, replyTo: session.email });
      sentCount++;
    } catch (err) {
      console.error(`Correction-request email to ${to} failed:`, err.message);
    }
  }

  return json(200, { ok: true, notified: sentCount });
}
