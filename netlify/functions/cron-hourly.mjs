/**
 * cron-hourly.mjs
 *
 * Netlify Scheduled Function. Runs once an hour, every hour.
 *
 * On each tick: look at every 'running' cohort and decide whether
 * NOW matches that cohort's configured reminder window. If yes,
 * send the appropriate emails for that cohort. This is what lets
 * each cohort have its own schedule (Cohort 10 runs Saturdays at
 * 07:00 Lagos; Cohort 11 might run Sundays at 14:00 GMT).
 *
 * Two job types:
 *   reminder — Saturday-morning "check-in" nudge. Triggered when
 *              the current UTC day-of-week + hour match the
 *              cohort's reminder_cron_dow/hour AND today IS a
 *              session day for this cohort.
 *   atrisk   — Wednesday "you're falling behind" warning. Triggered
 *              when the current UTC day-of-week + hour match the
 *              cohort's atrisk_cron_dow/hour.
 *
 * Idempotency: each job-cohort pair writes a 'cron_run' row to
 * audit_log with a date-prefix payload. If the same job already
 * ran today for this cohort, we skip.
 */

import { query, queryOne } from './_lib/db.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import { audit, requireEnv } from './_lib/http.mjs';

const INTER_EMAIL_MS = 700;       // ~85/min — safely under Gmail rate limit
const MAX_PER_COHORT = 1500;      // hard cap per job

export const handler = async () => {
  const envCheck = requireEnv([
    'DATABASE_URL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PORTAL_BASE_URL',
  ]);
  if (envCheck) {
    console.error('cron-hourly: missing env vars'); return { statusCode: 500, body: 'missing env' };
  }

  const now    = new Date();
  const dow    = now.getUTCDay();      // 0=Sun..6=Sat
  const hour   = now.getUTCHours();
  const today  = now.toISOString().slice(0, 10);
  console.log(`cron-hourly: UTC ${today} ${hour}:00 (dow=${dow})`);

  // Pull all running cohorts
  const cohorts = await query(
    `SELECT id, number,
            reminder_cron_dow, reminder_cron_hour_utc,
            atrisk_cron_dow,   atrisk_cron_hour_utc,
            email_from_name, email_reply_to
       FROM cohorts WHERE status = 'running'`
  );

  let totalSent = 0;

  for (const cohort of cohorts) {
    // Reminder window?
    if (cohort.reminder_cron_dow === dow && cohort.reminder_cron_hour_utc === hour) {
      const alreadyRan = await queryOne(
        `SELECT id FROM audit_log
          WHERE action = 'cron_reminder_done'
            AND cohort_id = $1
            AND occurred_at::date = $2::date`,
        [cohort.id, today]
      );
      if (!alreadyRan) {
        const sent = await runReminderForCohort(cohort, today);
        totalSent += sent;
      } else {
        console.log(`  cohort ${cohort.number}: reminder already ran today, skipping`);
      }
    }

    // At-risk window?
    if (cohort.atrisk_cron_dow === dow && cohort.atrisk_cron_hour_utc === hour) {
      const alreadyRan = await queryOne(
        `SELECT id FROM audit_log
          WHERE action = 'cron_atrisk_done'
            AND cohort_id = $1
            AND occurred_at::date = $2::date`,
        [cohort.id, today]
      );
      if (!alreadyRan) {
        const sent = await runAtRiskForCohort(cohort);
        totalSent += sent;
      } else {
        console.log(`  cohort ${cohort.number}: at-risk already ran today, skipping`);
      }
    }
  }

  console.log(`cron-hourly done. Total sent: ${totalSent}`);
  return { statusCode: 200, body: `sent=${totalSent}` };
};


async function runReminderForCohort(cohort, today) {
  // Is there a session today for this cohort?
  const sessions = await query(
    `SELECT id, week_number, topic
       FROM sessions
      WHERE cohort_id = $1 AND session_date = $2 AND is_break = false`,
    [cohort.id, today]
  );
  if (sessions.length === 0) {
    console.log(`  cohort ${cohort.number}: no session today; reminder skipped`);
    return 0;
  }

  let sent = 0, failed = 0;

  for (const sess of sessions) {
    const recipients = await query(
      `SELECT p.email, p.first_name, e.id AS enrolment_id
         FROM enrolments e
         JOIN people p ON p.id = e.person_id
        WHERE e.cohort_id = $1
          AND e.role = 'student' AND e.status = 'active'
          AND $2 BETWEEN e.joined_week AND COALESCE(e.left_week, 999)
          AND NOT EXISTS (
            SELECT 1 FROM attendance a
             WHERE a.enrolment_id = e.id AND a.session_id = $3
          )
        LIMIT $4`,
      [cohort.id, sess.week_number, sess.id, MAX_PER_COHORT]
    );

    console.log(`  cohort ${cohort.number} W${sess.week_number}: queuing ${recipients.length} reminders`);

    const portalUrl = `${process.env.PORTAL_BASE_URL.replace(/\/$/, '')}/${cohort.number}/check-in`;

    for (const r of recipients) {
      const firstName = r.first_name || r.email.split('@')[0];
      const { text, html } = renderEmail({
        heading: `Saturday check-in — Week ${sess.week_number}`,
        paragraphs: [
          `Hi ${firstName},`,
          `Today's session is "${sess.topic}". Once you've joined (or watched the recording later), open the check-in below to mark your attendance.`,
          `It takes about 30 seconds — and your feedback shapes how the next session lands.`,
        ],
        cta: { label: 'Open check-in →', url: portalUrl },
        footer: `Questions? Reply to this email, or use the cohort Discord.`,
      });

      try {
        await sendMail({
          to: r.email,
          subject: `Week ${sess.week_number}: ${sess.topic} — check-in`,
          text, html,
          replyTo: cohort.email_reply_to || undefined,
        });
        sent++;
      } catch (err) {
        console.error(`  send to ${r.email} failed:`, err.message);
        failed++;
      }
      await new Promise(res => setTimeout(res, INTER_EMAIL_MS));
    }
  }

  await audit({
    action:    'cron_reminder_done',
    actorKind: 'system',
    cohortId:  cohort.id,
    payload:   { sent, failed, date: today },
  });
  return sent;
}


async function runAtRiskForCohort(cohort) {
  const atRisk = await query(
    `SELECT s.enrolment_id, s.risk_status, s.attendance_pct, s.missed_count,
            s.cert_attendance_pct, p.email, p.first_name
       FROM student_attendance_summary s
       JOIN enrolments e ON e.id = s.enrolment_id
       JOIN people p     ON p.id = e.person_id
      WHERE s.cohort_id = $1
        AND s.risk_status IN ('warning', 'critical')
      ORDER BY
        CASE s.risk_status WHEN 'critical' THEN 0 ELSE 1 END,
        s.missed_count DESC`,
    [cohort.id]
  );

  // Dedup vs recent notifications (14 days)
  const recent = await query(
    `SELECT target_id::text, payload FROM audit_log
      WHERE action = 'atrisk_notified'
        AND occurred_at > now() - interval '14 days'
        AND cohort_id = $1`,
    [cohort.id]
  );
  const notified = new Set();
  for (const r of recent) {
    const lvl = r.payload?.level;
    if (lvl) notified.add(`${r.target_id}|${lvl}`);
  }

  let sent = 0, failed = 0;

  for (const st of atRisk) {
    const key = `${st.enrolment_id}|${st.risk_status}`;
    if (notified.has(key)) continue;

    const firstName = st.first_name || st.email.split('@')[0];
    const portalUrl = `${process.env.PORTAL_BASE_URL.replace(/\/$/, '')}/${cohort.number}/me`;
    const isCritical = st.risk_status === 'critical';

    const { text, html } = isCritical
      ? renderEmail({
          heading: `Cohort ${cohort.number} — your attendance update`,
          paragraphs: [
            `Hi ${firstName},`,
            `We noticed you've missed ${st.missed_count} sessions so far. Certificate eligibility requires ${st.cert_attendance_pct}% attendance, and you're currently at ${st.attendance_pct ?? '—'}%.`,
            `This isn't a judgment — life happens. But we want you to know where you stand so you can decide about the next few weeks.`,
            `If you can attend the remaining sessions (or watch the recordings within the week), you're still on track. Open your status page to see the exact path forward.`,
          ],
          cta: { label: 'Open my status →', url: portalUrl },
          footer: 'Reply to this email if you want to talk about it.',
        })
      : renderEmail({
          heading: `Cohort ${cohort.number} — quick check-in`,
          paragraphs: [
            `Hi ${firstName},`,
            `You've missed ${st.missed_count} session${st.missed_count === 1 ? '' : 's'} so far. Still well within reach of the ${st.cert_attendance_pct}% threshold, but worth flagging now.`,
            `If something's getting in the way, replies to this email go straight to the organisers — we're happy to brainstorm.`,
          ],
          cta: { label: 'See my attendance →', url: portalUrl },
        });

    try {
      await sendMail({
        to: st.email,
        subject: isCritical
          ? `Cohort ${cohort.number}: where you stand on attendance`
          : `Cohort ${cohort.number}: a quick attendance heads-up`,
        text, html,
        replyTo: cohort.email_reply_to || undefined,
      });
      sent++;
      await audit({
        action:    'atrisk_notified',
        actorKind: 'system',
        actorEmail: st.email,
        cohortId:   cohort.id,
        targetType: 'enrolment',
        targetId:   st.enrolment_id,
        payload:    { level: st.risk_status, missed: st.missed_count, pct: st.attendance_pct },
      });
    } catch (err) {
      console.error(`  at-risk send to ${st.email} failed:`, err.message);
      failed++;
    }
    await new Promise(res => setTimeout(res, 1000));
  }

  await audit({
    action:    'cron_atrisk_done',
    actorKind: 'system',
    cohortId:  cohort.id,
    payload:   { sent, failed },
  });
  return sent;
}


// Run hourly. Each tick the function decides which cohorts (if any)
// have their reminder/at-risk window NOW.
export const config = {
  schedule: '0 * * * *',
};
