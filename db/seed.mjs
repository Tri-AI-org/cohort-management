#!/usr/bin/env node
/**
 * db/seed.mjs
 *
 * Seeds the database with cohort rows + sessions. Reads from the
 * Astro content collection (src/content/cohorts/*.md), so the
 * editorial source of truth (markdown) and the queryable source
 * (Postgres) stay aligned without two-way sync.
 *
 * Idempotent: re-running upserts. Safe to run after every cohort
 * markdown change. Run as:
 *
 *   DATABASE_URL=... node db/seed.mjs
 *
 * Or via:  npm run db:seed
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname }     from 'node:path';
import { fileURLToPath }     from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  process.exit(1);
}

// ── Minimal frontmatter parser ──────────────────────────────────
// We don't want to pull in gray-matter just for this; the frontmatter
// shape is constrained and predictable. Handles strings, numbers,
// booleans, and one level of nested objects (which is all we need).

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) {
    throw new Error('No frontmatter found');
  }
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) throw new Error('Unterminated frontmatter');
  const yaml = text.slice(4, end);

  // Hand-rolled YAML-ish parser. Each top-level key: value pair, with
  // nested indented blocks supported one level deep.
  const result = {};
  let currentKey = null;
  let currentArr = null;
  let currentObj = null;

  for (const line of yaml.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;

    if (line.startsWith('  - ') && currentArr) {
      currentArr.push(coerceValue(line.slice(4).trim()));
      continue;
    }
    if (line.startsWith('  ') && currentObj) {
      const m = line.trim().match(/^([^:]+):\s*(.*)$/);
      if (m) currentObj[m[1].trim()] = coerceValue(m[2]);
      continue;
    }

    const m = line.match(/^([a-zA-Z_][\w]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    currentKey = key;

    if (rawValue === '') {
      // Could open an array or an object. We don't know yet.
      // Initialise both — the next line will pick one.
      currentArr = [];
      currentObj = {};
      result[key] = currentArr;          // optimistic; replaced below if obj
      continue;
    }

    result[key] = coerceValue(rawValue);
    currentArr = null;
    currentObj = null;
  }

  // Sweep: any "array" that has zero entries but we have an object
  // candidate filled becomes the object. (Imperfect but works for
  // our schemas.)
  for (const k of Object.keys(result)) {
    if (Array.isArray(result[k]) && result[k].length === 0 && currentObj && Object.keys(currentObj).length > 0) {
      result[k] = currentObj;
      currentObj = null;
    }
  }

  return result;
}

function coerceValue(s) {
  s = s.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  // Strip surrounding quotes if present
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}


// ── The seed run ───────────────────────────────────────────────

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: false },
});

async function run() {
  await client.connect();
  console.log('Connected.');

  const cohortDir = join(__dirname, '..', 'src', 'content', 'cohorts');
  const files = (await readdir(cohortDir)).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const raw = await readFile(join(cohortDir, file), 'utf8');
    let fm;
    try {
      fm = parseFrontmatter(raw);
    } catch (err) {
      console.error(`  skip ${file}: ${err.message}`);
      continue;
    }

    // Required keys.
    if (typeof fm.number !== 'number') {
      console.error(`  skip ${file}: no 'number' in frontmatter`);
      continue;
    }

    console.log(`\n→ Cohort ${fm.number} (from ${file})`);

    // Upsert the cohort row. Fields we care about for seeding:
    //   number, title, partner, status, start_date, end_date,
    //   break_week, total_weeks, cert_attendance_pct
    await client.query(
      `INSERT INTO cohorts (number, title, partner, status,
                            start_date, end_date, break_week,
                            total_weeks, cert_attendance_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               COALESCE($8, 16), COALESCE($9, 60))
       ON CONFLICT (number) DO UPDATE SET
         title  = EXCLUDED.title,
         partner= EXCLUDED.partner,
         status = EXCLUDED.status,
         start_date = EXCLUDED.start_date,
         end_date   = EXCLUDED.end_date,
         break_week = EXCLUDED.break_week,
         total_weeks = COALESCE(EXCLUDED.total_weeks, cohorts.total_weeks),
         cert_attendance_pct = COALESCE(EXCLUDED.cert_attendance_pct, cohorts.cert_attendance_pct)`,
      [
        fm.number,
        fm.title || `Cohort ${fm.number}`,
        fm.partner || null,
        fm.status || 'upcoming',
        fm.start_date || fm.startDate || null,
        fm.end_date   || fm.endDate   || null,
        typeof fm.break_week === 'number' ? fm.break_week
          : (typeof fm.breakWeek === 'number' ? fm.breakWeek : null),
        fm.total_weeks || fm.totalWeeks || null,
        fm.cert_attendance_pct || null,
      ]
    );

    // Get back the cohort id.
    const { rows: [{ id: cohortId }] } = await client.query(
      `SELECT id FROM cohorts WHERE number = $1`, [fm.number]
    );

    // Seed sessions if a schedule array is present.
    const schedule = Array.isArray(fm.schedule) ? fm.schedule : null;
    if (!schedule || schedule.length === 0) {
      console.log(`  no schedule in frontmatter — sessions not seeded`);
      continue;
    }

    let upserted = 0;
    for (let i = 0; i < schedule.length; i++) {
      const item = schedule[i];
      if (typeof item !== 'object' || item === null) continue;
      const week = item.week || (i + 1);
      const date = item.date || item.session_date;
      const topic = item.topic || item.title || `Week ${week}`;
      const isBreak = !!(item.is_break || item.isBreak ||
                         (typeof item.topic === 'string' && /break/i.test(item.topic)));

      if (!date) {
        console.warn(`  skip week ${week}: no date`);
        continue;
      }

      await client.query(
        `INSERT INTO sessions (cohort_id, week_number, session_date, topic, is_break)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cohort_id, week_number) DO UPDATE SET
           session_date = EXCLUDED.session_date,
           topic        = EXCLUDED.topic,
           is_break     = EXCLUDED.is_break`,
        [cohortId, week, date, topic, isBreak]
      );
      upserted++;
    }
    console.log(`  ${upserted} session(s) upserted`);
  }

  await client.end();
  console.log('\nSeed complete.');
}

run().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
