/**
 * cohort-settings.mjs
 *
 * Read, update, and create cohorts. The single place where cohort
 * configuration is mutated through the admin UI — replaces editing
 * markdown frontmatter for everything except curriculum copy on
 * the public marketing site.
 *
 * Actions:
 *   get    → return everything about a cohort, including sessions
 *   update → patch cohort columns
 *   create → make a new cohort (used by the Cohort 11 wizard)
 *
 * Organiser-only. Every mutation goes through audit_log.
 */

import { query, queryOne } from './_lib/db.mjs';
import { getSession }      from './_lib/auth.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  getClientIp, audit,
} from './_lib/http.mjs';

// Whitelist of columns the UI can write. Anything else in the body
// is ignored. Prevents an organiser from setting `id` or
// `created_at` by mistake (or malice).
const WRITABLE_COLUMNS = [
  'title', 'partner', 'status',
  'start_date', 'end_date', 'break_week', 'total_weeks',
  'cert_attendance_pct', 'atrisk_warn_misses', 'atrisk_crit_misses',
  'year', 'summary', 'format', 'duration_label',
  'discord_url', 'mailing_list_url', 'skills_boost_url', 'main_site_url',
  'reminder_cron_dow', 'reminder_cron_hour_utc',
  'atrisk_cron_dow',   'atrisk_cron_hour_utc',
  'email_from_name', 'email_reply_to',
  'session_day_of_week',
  'portal_flags',
];

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
    case 'get':    return getCohort(body);
    case 'list':   return listCohorts();
    case 'update': return updateCohort(body, session, ip, ua);
    case 'create': return createCohort(body, session, ip, ua);
    default:       return json(400, { error: 'Unknown action' });
  }
};

async function getCohort({ cohort }) {
  const num = Number(cohort);
  if (!num) return json(400, { error: 'cohort is required' });
  const row = await queryOne(
    `SELECT * FROM cohort_full WHERE number = $1`,
    [num]
  );
  if (!row) return json(404, { error: `Cohort ${num} not found` });
  return json(200, { cohort: row });
}

async function listCohorts() {
  const rows = await query(
    `SELECT id, number, title, partner, status, start_date, end_date,
            year, total_weeks, created_at
       FROM cohorts ORDER BY number DESC`
  );
  return json(200, { cohorts: rows });
}

async function updateCohort(body, session, ip, ua) {
  const num = Number(body.cohort);
  if (!num) return json(400, { error: 'cohort is required' });

  const existing = await queryOne(`SELECT id, number FROM cohorts WHERE number = $1`, [num]);
  if (!existing) return json(404, { error: `Cohort ${num} not found` });

  // Filter body.fields down to writable columns only.
  const patch = body.fields || {};
  const updates = [];
  const params  = [existing.id];
  for (const col of WRITABLE_COLUMNS) {
    if (!(col in patch)) continue;
    let val = patch[col];

    // Some basic validation/coercion per column
    if (col === 'portal_flags' && typeof val === 'object' && val !== null) {
      val = JSON.stringify(val);
    }
    if (['break_week', 'total_weeks', 'year',
         'cert_attendance_pct', 'atrisk_warn_misses', 'atrisk_crit_misses',
         'reminder_cron_dow', 'reminder_cron_hour_utc',
         'atrisk_cron_dow', 'atrisk_cron_hour_utc',
         'session_day_of_week'].includes(col)) {
      if (val === '' || val === null) val = null;
      else val = parseInt(val, 10);
      if (val !== null && isNaN(val)) {
        return json(400, { error: `${col} must be a number` });
      }
    }
    if (['start_date', 'end_date'].includes(col)) {
      if (val === '' || val === null) val = null;
    }

    params.push(val);
    updates.push(`${col} = $${params.length}`);
  }

  if (updates.length === 0) {
    return json(400, { error: 'No editable fields provided' });
  }

  await query(`UPDATE cohorts SET ${updates.join(', ')} WHERE id = $1`, params);

  await audit({
    action:     'cohort_updated',
    actorEmail: session.email,
    cohortId:   existing.id,
    targetType: 'cohort', targetId: existing.id,
    ip, userAgent: ua,
    payload:    { fields: Object.keys(patch) },
  });

  const fresh = await queryOne(`SELECT * FROM cohort_full WHERE number = $1`, [num]);
  return json(200, { cohort: fresh });
}

async function createCohort(body, session, ip, ua) {
  const num = parseInt(body.number, 10);
  if (!num || num < 1) return json(400, { error: 'A positive integer cohort number is required' });

  const dup = await queryOne(`SELECT id FROM cohorts WHERE number = $1`, [num]);
  if (dup) return json(409, { error: `Cohort ${num} already exists` });

  const title         = String(body.title || `Cohort ${num}`).trim();
  const partner       = body.partner ? String(body.partner).trim() : null;
  const startDate     = body.start_date || null;
  const endDate       = body.end_date   || null;
  const totalWeeks    = parseInt(body.total_weeks, 10) || 16;
  const breakWeek     = body.break_week ? parseInt(body.break_week, 10) : null;
  const year          = body.year ? parseInt(body.year, 10) : new Date().getFullYear();

  const created = await queryOne(
    `INSERT INTO cohorts
       (number, title, partner, status, start_date, end_date,
        break_week, total_weeks, year)
     VALUES ($1, $2, $3, 'upcoming', $4, $5, $6, $7, $8)
     RETURNING *`,
    [num, title, partner, startDate, endDate, breakWeek, totalWeeks, year]
  );

  // Auto-generate session rows. Pattern: weekly, falling on
  // session_day_of_week from the start_date. If start_date is null,
  // we still create N session rows with NULL dates so the schedule
  // page has rows to edit.
  if (totalWeeks > 0) {
    const sessions = [];
    let cursor = startDate ? new Date(startDate + 'T00:00:00Z') : null;
    for (let w = 1; w <= totalWeeks; w++) {
      const date = cursor ? cursor.toISOString().slice(0, 10) : null;
      const isBreak = breakWeek && w === breakWeek;
      sessions.push([
        created.id, w, date,
        isBreak ? 'Mid-cohort break' : `Week ${w}`,
        isBreak,
      ]);
      if (cursor) cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    // Bulk insert
    const placeholders = sessions.map((_, i) => {
      const o = i * 5;
      return `($${o+1}, $${o+2}, $${o+3}, $${o+4}, $${o+5})`;
    }).join(', ');
    const flat = sessions.flat();
    await query(
      `INSERT INTO sessions (cohort_id, week_number, session_date, topic, is_break)
         VALUES ${placeholders}`,
      flat
    );
  }

  await audit({
    action:     'cohort_created',
    actorEmail: session.email,
    cohortId:   created.id,
    targetType: 'cohort', targetId: created.id,
    ip, userAgent: ua,
    payload:    { number: num, totalWeeks },
  });

  const fresh = await queryOne(`SELECT * FROM cohort_full WHERE number = $1`, [num]);
  return json(200, { cohort: fresh });
}
