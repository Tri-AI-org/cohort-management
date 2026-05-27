/**
 * cron-hourly.mjs
 *
 * Scheduled function. Runs at the top of every hour. Decides which
 * cohorts need a reminder or at-risk job to run NOW (based on per-cohort
 * cron config in the cohorts table), then dispatches to background
 * functions to do the actual work.
 *
 * Why split: Netlify Scheduled Functions have a 30-second execution
 * limit. Sending 1000+ emails sequentially at safe Gmail rates takes
 * much longer than that. Background functions allow up to 15 minutes,
 * which is enough for ~750 emails at our 1200ms pace.
 *
 * Idempotency: each (cohort, job, day) writes an audit_log row so a
 * second tick on the same hour doesn't re-trigger the same job.
 */

import { query, queryOne } from './_lib/db.mjs';
import { audit, requireEnv } from './_lib/http.mjs';

export const handler = async () => {
  const envCheck = requireEnv(['DATABASE_URL', 'PORTAL_BASE_URL']);
  if (envCheck) {
    console.error('cron-hourly: missing env vars');
    return { statusCode: 500, body: 'missing env' };
  }

  const now    = new Date();
  const dow    = now.getUTCDay();
  const hour   = now.getUTCHours();
  const today  = now.toISOString().slice(0, 10);
  console.log(`cron-hourly: UTC ${today} ${hour}:00 (dow=${dow})`);

  const cohorts = await query(
    `SELECT id, number,
            reminder_cron_dow, reminder_cron_hour_utc,
            atrisk_cron_dow,   atrisk_cron_hour_utc
       FROM cohorts WHERE status = 'running'`
  );

  let dispatched = 0;

  for (const cohort of cohorts) {
    // Reminder window?
    if (cohort.reminder_cron_dow === dow && cohort.reminder_cron_hour_utc === hour) {
      const alreadyRan = await queryOne(
        `SELECT id FROM audit_log
          WHERE action = 'cron_reminder_dispatched'
            AND cohort_id = $1
            AND occurred_at::date = $2::date`,
        [cohort.id, today]
      );
      if (!alreadyRan) {
        // Verify there's actually a session today before dispatching.
        const sess = await queryOne(
          `SELECT id FROM sessions WHERE cohort_id = $1 AND session_date = $2 AND is_break = false LIMIT 1`,
          [cohort.id, today]
        );
        if (sess) {
          await dispatchBackground('reminders-background', {
            cohort_id: cohort.id, cohort_number: cohort.number, today,
          });
          await audit({
            action: 'cron_reminder_dispatched', actorKind: 'system',
            cohortId: cohort.id, payload: { date: today },
          });
          dispatched++;
          console.log(`  cohort ${cohort.number}: reminder dispatched`);
        } else {
          console.log(`  cohort ${cohort.number}: no session today; reminder skipped`);
        }
      } else {
        console.log(`  cohort ${cohort.number}: reminder already ran today`);
      }
    }

    // At-risk window?
    if (cohort.atrisk_cron_dow === dow && cohort.atrisk_cron_hour_utc === hour) {
      const alreadyRan = await queryOne(
        `SELECT id FROM audit_log
          WHERE action = 'cron_atrisk_dispatched'
            AND cohort_id = $1
            AND occurred_at::date = $2::date`,
        [cohort.id, today]
      );
      if (!alreadyRan) {
        await dispatchBackground('atrisk-background', {
          cohort_id: cohort.id, cohort_number: cohort.number,
        });
        await audit({
          action: 'cron_atrisk_dispatched', actorKind: 'system',
          cohortId: cohort.id, payload: { date: today },
        });
        dispatched++;
        console.log(`  cohort ${cohort.number}: at-risk dispatched`);
      } else {
        console.log(`  cohort ${cohort.number}: at-risk already ran today`);
      }
    }
  }

  console.log(`cron-hourly done. Dispatched: ${dispatched}`);
  return { statusCode: 200, body: `dispatched=${dispatched}` };
};

/**
 * Fire-and-forget POST to a background function. Background functions
 * return 202 immediately and the real work happens after we've already
 * returned from cron-hourly. We don't await the response body, only
 * the HTTP status to confirm the dispatch went through.
 */
async function dispatchBackground(functionName, payload) {
  const baseUrl = process.env.URL || process.env.PORTAL_BASE_URL;
  const url     = `${baseUrl.replace(/\/$/, '')}/.netlify/functions/${functionName}`;
  // Use a system-issued auth header so the background function knows
  // the call came from cron-hourly (and not just anyone hitting the URL).
  const systemAuth = process.env.SYSTEM_CRON_SECRET || '';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-system-cron':  systemAuth,
      },
      body: JSON.stringify(payload),
    });
    if (r.status !== 202 && r.status !== 200) {
      console.error(`  dispatch to ${functionName} returned ${r.status}`);
    }
  } catch (err) {
    console.error(`  dispatch to ${functionName} threw:`, err.message);
  }
}

export const config = {
  schedule: '0 * * * *',
};
