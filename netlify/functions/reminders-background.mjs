/**
 * reminders-background.mjs
 *
 * Background Function (15-minute runtime). Invoked by cron-hourly when
 * the current hour is the reminder window for a running cohort. Sends
 * a magic-link-embedded reminder to every active student who hasn't
 * yet checked in for today's session.
 *
 * Pacing: 1200ms between sends = ~50/min. At this rate, 750 emails
 * take 15 minutes — about the maximum for a single background
 * function invocation. For cohorts larger than ~750 active students,
 * see the README note about splitting across multiple invocations or
 * moving to Gmail's SMTP relay service.
 *
 * Auth: cron-hourly forwards an x-system-cron secret header. Without
 * a matching SYSTEM_CRON_SECRET env var, this endpoint refuses to run.
 * (Set SYSTEM_CRON_SECRET in Netlify env to any random string.)
 */

import { query }            from './_lib/db.mjs';
import { newMagicToken }    from './_lib/auth.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import { audit, requireEnv } from './_lib/http.mjs';

const INTER_EMAIL_MS = 1200;             // ~50/min — under Gmail burst throttle
const MAX_PER_RUN    = 700;              // ~14 min at the above pacing
const TOKEN_TTL_HOURS = 36;              // good for the weekend

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  // Auth gate — only cron-hourly should call this
  const expected = process.env.SYSTEM_CRON_SECRET || '';
  const got      = event.headers['x-system-cron'] || event.headers['X-System-Cron'] || '';
  if (!expected || got !== expected) {
    console.warn('reminders-background: rejected — bad or missing x-system-cron');
    return { statusCode: 401, body: 'unauthorized' };
  }

  const envCheck = requireEnv([
    'DATABASE_URL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PORTAL_BASE_URL',
  ]);
  if (envCheck) return { statusCode: 500, body: 'missing env' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'invalid JSON' }; }

  const cohortId     = body.cohort_id;
  const cohortNumber = body.cohort_number;
  const today        = body.today;
  if (!cohortId || !cohortNumber || !today) {
    return { statusCode: 400, body: 'missing cohort_id, cohort_number, or today' };
  }

  console.log(`reminders-background: cohort ${cohortNumber}, ${today}`);

  // Today's sessions for this cohort (could be more than one if a
  // cohort somehow has parallel weeks, but normally just one).
  const sessions = await query(
    `SELECT id, week_number, topic
       FROM sessions
      WHERE cohort_id = $1 AND session_date = $2 AND is_break = false`,
    [cohortId, today]
  );

  let totalSent = 0, totalFailed = 0;

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
      [cohortId, sess.week_number, sess.id, MAX_PER_RUN]
    );

    console.log(`  W${sess.week_number}: queuing ${recipients.length} reminder(s) (max per run: ${MAX_PER_RUN})`);

    const portalBase = process.env.PORTAL_BASE_URL.replace(/\/$/, '');
    const checkInPath = `/${cohortNumber}/check-in`;
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);

    for (const r of recipients) {
      const firstName = r.first_name || r.email.split('@')[0];

      // Mint a signed magic-link token for this recipient. Clicking
      // the email logs them in and lands them at /check-in.
      const { token, tokenHash } = newMagicToken();
      try {
        await query(
          `INSERT INTO magic_link_tokens
             (token_hash, email, cohort_id, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [tokenHash, r.email, cohortId, tokenExpiresAt]
        );
      } catch (err) {
        console.error(`  token mint failed for ${r.email}:`, err.message);
        totalFailed++;
        continue;
      }

      const checkInUrl = `${portalBase}/auth/callback?t=${encodeURIComponent(token)}` +
                         `&next=${encodeURIComponent(checkInPath)}`;

      const { text, html } = renderEmail({
        heading: `Saturday check-in — Week ${sess.week_number}`,
        paragraphs: [
          `Hi ${firstName},`,
          `Today's session is "${sess.topic}". When you've joined (or watched the recording), tap the button below to mark your attendance — no email entry needed, this link signs you in.`,
          `Takes about 30 seconds. Your feedback shapes how the next session lands.`,
        ],
        cta: { label: 'Open check-in →', url: checkInUrl },
        footer: `This link is good for ${TOKEN_TTL_HOURS} hours. Replies to this email go to the cohort organisers.`,
      });

      try {
        await sendMail({
          to: r.email,
          subject: `Week ${sess.week_number}: ${sess.topic} — check-in`,
          text, html,
        });
        totalSent++;
      } catch (err) {
        console.error(`  send to ${r.email} failed:`, err.message);
        totalFailed++;
      }
      await new Promise(res => setTimeout(res, INTER_EMAIL_MS));
    }
  }

  await audit({
    action:    'cron_reminder_done',
    actorKind: 'system',
    cohortId,
    payload:   { sent: totalSent, failed: totalFailed, date: today },
  });

  console.log(`reminders-background done. Sent: ${totalSent}, failed: ${totalFailed}`);
  return { statusCode: 200, body: JSON.stringify({ sent: totalSent, failed: totalFailed }) };
};
