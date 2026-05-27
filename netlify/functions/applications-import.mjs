/**
 * applications-import.mjs
 *
 * Organiser uploads a Google Forms CSV → preview, then confirm.
 *
 * POST /.netlify/functions/applications-import
 *
 *   Body: { cohort: 10, csv: "<csv text>", confirm: true|false }
 *
 *   confirm=false (default) returns a preview: counts, new vs
 *   returning applicants, validation errors. NOTHING is written.
 *
 *   confirm=true performs the actual import in a transaction
 *   inside a single import_batches row. If anything fails, the
 *   whole import rolls back — no half-imported state.
 *
 * Organiser-only. Auth is checked via session cookie.
 */

import { parse } from 'csv-parse/sync';
import { queryOne, query, tx } from './_lib/db.mjs';
import { mapRow } from './_lib/application-mapping.mjs';
import { getSession } from './_lib/auth.mjs';
import {
  json, preflight, parseJsonBody, requireEnv,
  getClientIp, audit,
} from './_lib/http.mjs';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['DATABASE_URL', 'SESSION_SECRET']);
  if (envCheck) return envCheck;

  // Organiser-only
  const session = getSession(event);
  if (!session || session.kind !== 'organiser') {
    return json(401, { error: 'Not signed in as an organiser' });
  }

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const cohortNumber = Number(body.cohort);
  const csvText      = String(body.csv || '');
  const confirm      = !!body.confirm;
  const filename     = String(body.filename || 'upload.csv');

  if (!cohortNumber) return json(400, { error: 'cohort is required' });
  if (!csvText)      return json(400, { error: 'csv is required' });

  const cohort = await queryOne(
    `SELECT id, number FROM cohorts WHERE number = $1`,
    [cohortNumber]
  );
  if (!cohort) return json(404, { error: `Cohort ${cohortNumber} not found` });

  // Parse the CSV. csv-parse handles quoted fields with newlines
  // inside them (which Google Forms outputs for long-form answers).
  let rows;
  try {
    rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: false,                            // mapping does its own trimming
      relax_column_count: true,
    });
  } catch (err) {
    return json(400, { error: `CSV parse failed: ${err.message}` });
  }

  if (rows.length === 0) {
    return json(400, { error: 'CSV is empty' });
  }

  // ── Map each row ──────────────────────────────────────────
  const mapped = [];
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const { person, application } = mapRow(rows[i]);
      if (!person.email) {
        errors.push({ row: i + 2, error: 'Missing email' });   // +2 for header + 1-indexed
        continue;
      }
      mapped.push({ idx: i, person, application });
    } catch (err) {
      errors.push({ row: i + 2, error: err.message });
    }
  }

  // ── Identify new vs returning applicants ──────────────────
  // We do this regardless of preview/confirm so the preview can
  // show it. A second query in the confirm path is the price of
  // shared logic; it's cheap.
  const emails = [...new Set(mapped.map(m => m.person.email))];
  const existing = emails.length === 0 ? [] : await query(
    `SELECT id, email, first_name, last_name FROM people WHERE email = ANY($1)`,
    [emails]
  );
  const existingByEmail = new Map(existing.map(p => [p.email.toLowerCase(), p]));

  // Detect within-CSV duplicates (the same email twice in the file).
  const seen = new Set();
  const dupesInCsv = [];
  for (const m of mapped) {
    const e = m.person.email.toLowerCase();
    if (seen.has(e)) dupesInCsv.push(e);
    else seen.add(e);
  }

  const newCount       = mapped.filter(m => !existingByEmail.has(m.person.email.toLowerCase())).length;
  const returningCount = mapped.length - newCount;

  // Already-applied-to-this-cohort: someone whose person row exists
  // AND who already has an applications row for this cohort. We
  // refuse to create a duplicate application — the import updates
  // instead.
  const existingAppPersonIds = existing.length === 0 ? [] : await query(
    `SELECT person_id, status FROM applications WHERE cohort_id = $1 AND person_id = ANY($2)`,
    [cohort.id, existing.map(p => p.id)]
  );
  const alreadyAppliedCount = existingAppPersonIds.length;

  // ── Preview mode ──────────────────────────────────────────
  if (!confirm) {
    return json(200, {
      preview: true,
      cohortNumber,
      summary: {
        totalRows:        rows.length,
        validRows:        mapped.length,
        errors:           errors.length,
        newApplicants:    newCount,
        returningApplicants: returningCount,
        alreadyAppliedToThisCohort: alreadyAppliedCount,
        duplicateEmailsInCsv: dupesInCsv.length,
      },
      errors: errors.slice(0, 20),                 // first 20, in case there are many
      returningExamples: existing.slice(0, 5).map(p => ({
        email: p.email,
        name: `${p.first_name} ${p.last_name}`,
      })),
    });
  }

  // ── Commit mode ────────────────────────────────────────────
  // Everything below runs in a single transaction so an exception
  // halfway through doesn't leave us with partial state.
  const ip = getClientIp(event);
  const ua = event.headers['user-agent'] || '';

  try {
    const result = await tx(async (c) => {
      // Open a batch.
      const batch = await c.query(
        `INSERT INTO import_batches
           (kind, cohort_id, imported_by, source_name, rows_total)
         VALUES ('applications', $1, $2, $3, $4)
         RETURNING id`,
        [cohort.id, session.email, filename, rows.length]
      );
      const batchId = batch.rows[0].id;

      let inserted = 0, updated = 0, skipped = 0;

      for (const m of mapped) {
        // Upsert the person. Existing person → update name fields
        // only if they're non-empty in the new submission (so a
        // typo'd entry doesn't overwrite a clean one).
        const personRow = await c.query(
          `INSERT INTO people
             (email, first_name, last_name, country, city, github_url,
              gender, age_range, programme_tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (email) DO UPDATE SET
             first_name  = COALESCE(NULLIF(EXCLUDED.first_name, ''),  people.first_name),
             last_name   = COALESCE(NULLIF(EXCLUDED.last_name,  ''),  people.last_name),
             country     = COALESCE(NULLIF(EXCLUDED.country,    ''),  people.country),
             city        = COALESCE(NULLIF(EXCLUDED.city,       ''),  people.city),
             github_url  = COALESCE(NULLIF(EXCLUDED.github_url, ''),  people.github_url),
             gender      = COALESCE(people.gender,    EXCLUDED.gender),
             age_range   = COALESCE(people.age_range, EXCLUDED.age_range)
           RETURNING id, (xmax = 0) AS inserted`,
          [
            m.person.email,
            m.person.first_name || '',
            m.person.last_name  || '',
            m.person.country    || null,
            m.person.city       || null,
            m.person.github_url || null,
            m.person.gender     || null,
            m.person.age_range  || null,
            cohort.id,           // not really programme_tags but we don't have it; fix later
          ]
        );
        const personId = personRow.rows[0].id;

        // Upsert the application. If they re-submit for the same
        // cohort, we update — Google Forms users can re-submit by
        // editing their response.
        const appCols = m.application;
        const insertedApp = await c.query(
          `INSERT INTO applications (
             person_id, cohort_id, import_batch_id, status, submitted_at,
             team_id_raw, previous_participant,
             prereq_python, prereq_statistics, prereq_linear_alg,
             prereq_numpy_pandas, prereq_ml_concepts,
             applicant_role, job_title, field_of_work,
             has_projects, project_description,
             has_leadership, leadership_type, leadership_description, team_style,
             community_problem, post_programme_goals, motivation,
             course_familiarity, can_commit_16w, hours_per_week,
             heard_about_us, consented, form_payload
           ) VALUES (
             $1, $2, $3, 'submitted', COALESCE($4, now()),
             $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19, $20,
             $21, $22, $23, $24, $25, $26, $27, $28, $29
           )
           ON CONFLICT (person_id, cohort_id) DO UPDATE SET
             submitted_at         = COALESCE(EXCLUDED.submitted_at, applications.submitted_at),
             team_id_raw          = COALESCE(EXCLUDED.team_id_raw, applications.team_id_raw),
             previous_participant = COALESCE(EXCLUDED.previous_participant, applications.previous_participant),
             prereq_python        = COALESCE(EXCLUDED.prereq_python, applications.prereq_python),
             prereq_statistics    = COALESCE(EXCLUDED.prereq_statistics, applications.prereq_statistics),
             prereq_linear_alg    = COALESCE(EXCLUDED.prereq_linear_alg, applications.prereq_linear_alg),
             prereq_numpy_pandas  = COALESCE(EXCLUDED.prereq_numpy_pandas, applications.prereq_numpy_pandas),
             prereq_ml_concepts   = COALESCE(EXCLUDED.prereq_ml_concepts, applications.prereq_ml_concepts),
             applicant_role         = COALESCE(EXCLUDED.applicant_role, applications.applicant_role),
             job_title            = COALESCE(EXCLUDED.job_title, applications.job_title),
             field_of_work        = COALESCE(EXCLUDED.field_of_work, applications.field_of_work),
             has_projects         = COALESCE(EXCLUDED.has_projects, applications.has_projects),
             project_description  = COALESCE(EXCLUDED.project_description, applications.project_description),
             has_leadership       = COALESCE(EXCLUDED.has_leadership, applications.has_leadership),
             leadership_type      = COALESCE(EXCLUDED.leadership_type, applications.leadership_type),
             leadership_description = COALESCE(EXCLUDED.leadership_description, applications.leadership_description),
             team_style           = COALESCE(EXCLUDED.team_style, applications.team_style),
             community_problem    = COALESCE(EXCLUDED.community_problem, applications.community_problem),
             post_programme_goals = COALESCE(EXCLUDED.post_programme_goals, applications.post_programme_goals),
             motivation           = COALESCE(EXCLUDED.motivation, applications.motivation),
             course_familiarity   = COALESCE(EXCLUDED.course_familiarity, applications.course_familiarity),
             can_commit_16w       = COALESCE(EXCLUDED.can_commit_16w, applications.can_commit_16w),
             hours_per_week       = COALESCE(EXCLUDED.hours_per_week, applications.hours_per_week),
             heard_about_us       = COALESCE(EXCLUDED.heard_about_us, applications.heard_about_us),
             consented            = applications.consented OR EXCLUDED.consented,
             form_payload         = EXCLUDED.form_payload   -- always overwrite
           RETURNING (xmax = 0) AS inserted`,
          [
            personId, cohort.id, batchId, appCols.submitted_at || null,
            appCols.team_id_raw || null, appCols.previous_participant ?? null,
            appCols.prereq_python ?? null, appCols.prereq_statistics ?? null,
            appCols.prereq_linear_alg ?? null, appCols.prereq_numpy_pandas ?? null,
            appCols.prereq_ml_concepts ?? null,
            appCols.applicant_role || null, appCols.job_title || null, appCols.field_of_work || null,
            appCols.has_projects ?? null, appCols.project_description || null,
            appCols.has_leadership ?? null, appCols.leadership_type || null,
            appCols.leadership_description || null, appCols.team_style || null,
            appCols.community_problem || null, appCols.post_programme_goals || null,
            appCols.motivation || null,
            appCols.course_familiarity || null, appCols.can_commit_16w ?? null,
            appCols.hours_per_week || null,
            appCols.heard_about_us || null, appCols.consented ?? false,
            JSON.stringify(appCols.form_payload || {}),
          ]
        );

        if (insertedApp.rows[0].inserted) inserted++;
        else updated++;
      }

      skipped = rows.length - mapped.length;

      // Finalise the batch counters.
      await c.query(
        `UPDATE import_batches
            SET rows_inserted = $2, rows_updated = $3, rows_skipped = $4
          WHERE id = $1`,
        [batchId, inserted, updated, skipped]
      );

      return { batchId, inserted, updated, skipped };
    });

    await audit({
      action: 'applications_imported',
      actorEmail: session.email,
      cohortId: cohort.id,
      targetType: 'import_batch', targetId: result.batchId,
      ip, userAgent: ua,
      payload: { inserted: result.inserted, updated: result.updated, skipped: result.skipped },
    });

    return json(200, {
      committed: true,
      cohortNumber,
      batchId: result.batchId,
      inserted: result.inserted,
      updated:  result.updated,
      skipped:  result.skipped,
    });
  } catch (err) {
    console.error('applications-import failed:', err);
    return json(500, { error: 'Import failed: ' + err.message });
  }
};
