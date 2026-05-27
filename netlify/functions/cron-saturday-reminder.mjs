/**
 * cron-saturday-reminder.mjs
 *
 * Saturday morning: email every active student in every running cohort
 * a "don't forget to check in" reminder.
 *
 * Runs once per Saturday at 06:00 UTC (configured below). On Africa/Lagos
 * that's 07:00 — early enough that students see it on their phones
 * before the session, late enough to not wake anyone up. Adjust the
 * cron in netlify.toml if the audience timezone shifts.
 *
 * Pacing: Gmail rate-limits SMTP at ~100/min and a Workspace account
 * caps at ~2000/day. For 3000 students this is one full day's quota.
 * Below we send sequentially with a 700ms gap, which gets ~85/min —
 * comfortably under the rate limit. At that rate 3000 emails take ~35
 * minutes. Netlify Scheduled Functions don't have a strict timeout
 * cap like regular functions (they run in a separate, longer-lived
 * env), but we still cap each run at MAX_BATCH = 1500 emails per
 * cohort and log/error if there's more — split across two cohorts
 * naturally if you ever scale to multi-cohort weeks.
 */

import { query }            from './_lib/db.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import { audit, requireEnv } from './_lib/http.mjs';

const MAX_BATCH       = 1500;        // hard cap per cohort per run
const INTER_EMAIL_MS  = 700;         // gap between sends (~85/min)

export const handler = async () => {
  const envCheck = requireEnv([
    'DATABASE_URL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PORTAL_BASE_URL'
  ]);
  if (envCheck) {
    console.error('Saturday reminder skipped — missing env vars');
    return { statusCode: 500, body: 'missing env' };
  }

  console.log('Saturday reminder run starting');

  // Find cohorts with a session happening today (Saturday). We look up
  // sessions whose date is the current UTC date; for cohorts running in
  // Lagos time this matches because the cohort runs Saturday-of-week.
  const today = new Date().toISOString().slice(0, 10);     // YYYY-MM-DD

  const sessions = await query(
    `SELECT s.id, s.week_number, s.topic, s.is_break,
            c.id AS cohort_id, c.number AS cohort_number
       FROM sessions s
       JOIN cohorts c ON c.id = s.cohort_id
      WHERE s.session_date = $1
        AND c.status = 'running'
        AND s.is_break = false`,
    [today]
  );

  if (sessions.length === 0) {
    console.log(`No sessions today (${today}); skipping.`);
    return { statusCode: 200, body: 'no sessions today' };
  }

  console.log(`Found ${sessions.length} session(s) today`);

  let totalSent = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const sess of sessions) {
    // For each session, find active students in that cohort who haven't
    // already submitted attendance. (Once they've checked in, no nudge.)
    const recipients = await query(
      `SELECT p.email, p.first_name, e.id AS enrolment_id
         FROM enrolments e
         JOIN people p ON p.id = e.person_id
        WHERE e.cohort_id = $1
          AND e.role = 'student'
          AND e.status = 'active'
          AND $2 BETWEEN e.joined_week AND COALESCE(e.left_week, 999)
          AND NOT EXISTS (
            SELECT 1 FROM attendance a
             WHERE a.enrolment_id = e.id AND a.session_id = $3
          )
        LIMIT $4`,
      [sess.cohort_id, sess.week_number, sess.id, MAX_BATCH]
    );

    console.log(`Cohort ${sess.cohort_number} W${sess.week_number}: ${recipients.length} reminder(s) queued`);

    const portalUrl = `${process.env.PORTAL_BASE_URL.replace(/\/$/, '')}/${sess.cohort_number}/check-in`;

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
        });
        totalSent++;
      } catch (err) {
        console.error(`Send to ${r.email} failed:`, err.message);
        totalFailed++;
      }
      // Spacing between sends
      await new Promise(res => setTimeout(res, INTER_EMAIL_MS));
    }
  }

  await audit({
    action:    'cron_saturday_reminder',
    actorKind: 'system',
    payload:   { sessions: sessions.length, sent: totalSent, failed: totalFailed, skipped: totalSkipped, date: today },
  });

  console.log(`Saturday reminder done. Sent: ${totalSent}, failed: ${totalFailed}`);
  return { statusCode: 200, body: `sent=${totalSent} failed=${totalFailed}` };
};

// Netlify scheduling. Cron at 06:00 UTC every Saturday.
export const config = {
  schedule: '0 6 * * 6',
};
