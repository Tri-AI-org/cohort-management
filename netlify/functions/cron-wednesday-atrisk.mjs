/**
 * cron-wednesday-atrisk.mjs
 *
 * Wednesday morning: email every student whose attendance is below
 * the cohort's at-risk threshold. The message is kind, factual,
 * non-judgmental — "we noticed, here's where you stand, you can
 * recover."
 *
 * Why Wednesday: gives students three days of context after Saturday's
 * session (so missed-attendance data is fresh) and three days before
 * the next Saturday (so they can plan to attend).
 *
 * Volume: at any time at-risk students should be <15% of cohort,
 * so for 3000-student Cohort 10 we expect ~400 emails max. That's
 * comfortably inside Gmail's daily quota even alongside the Saturday
 * blast.
 *
 * Two tiers:
 *   - 'warning' (missed 2): gentle reminder, no urgency
 *   - 'critical' (missed 3+): direct, clear about certificate risk
 *
 * Sent once per state transition — we record which students were
 * notified at which level, so a student going from 'ok' → 'warning'
 * gets the warning email, but stays at 'warning' next week without
 * spam. Going from 'warning' → 'critical' sends the critical email.
 *
 * Implementation uses the audit_log: we check if there's a recent
 * 'atrisk_notified' row for this enrolment + level. If yes, skip.
 */

import { query }            from './_lib/db.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import { audit, requireEnv } from './_lib/http.mjs';

const INTER_EMAIL_MS = 1000;   // 60/min — slow enough not to trip Gmail throttles
const RECENT_NOTIFY_DAYS = 14; // don't re-notify the same student at the same level inside this window

export const handler = async () => {
  const envCheck = requireEnv([
    'DATABASE_URL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PORTAL_BASE_URL'
  ]);
  if (envCheck) {
    console.error('Wednesday at-risk skipped — missing env vars');
    return { statusCode: 500, body: 'missing env' };
  }

  console.log('Wednesday at-risk run starting');

  // Pull at-risk students from the view we already have. Include cohort
  // number for URL building.
  const atRisk = await query(
    `SELECT s.enrolment_id, s.risk_status, s.attendance_pct, s.missed_count,
            s.cert_attendance_pct, p.email, p.first_name,
            c.number AS cohort_number
       FROM student_attendance_summary s
       JOIN enrolments e ON e.id = s.enrolment_id
       JOIN people p     ON p.id = e.person_id
       JOIN cohorts c    ON c.id = s.cohort_id
      WHERE s.risk_status IN ('warning', 'critical')
        AND c.status = 'running'
      ORDER BY
        CASE s.risk_status WHEN 'critical' THEN 0 ELSE 1 END,
        s.missed_count DESC`
  );

  console.log(`At-risk total: ${atRisk.length}`);

  if (atRisk.length === 0) {
    return { statusCode: 200, body: 'nobody at risk' };
  }

  // Filter out anyone who's been notified at the same level in the last
  // 14 days. (Inner join filtering done in SQL would be faster but the
  // numbers are small — Node-side dedup is clearer.)
  const recentlyNotified = await query(
    `SELECT target_id::text, payload
       FROM audit_log
      WHERE action = 'atrisk_notified'
        AND occurred_at > now() - interval '${RECENT_NOTIFY_DAYS} days'`
  );
  const notifiedKeys = new Set();
  for (const r of recentlyNotified) {
    const lvl = r.payload?.level;
    if (lvl) notifiedKeys.add(`${r.target_id}|${lvl}`);
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const st of atRisk) {
    const dedupeKey = `${st.enrolment_id}|${st.risk_status}`;
    if (notifiedKeys.has(dedupeKey)) {
      skipped++;
      continue;
    }

    const firstName = st.first_name || st.email.split('@')[0];
    const portalUrl = `${process.env.PORTAL_BASE_URL.replace(/\/$/, '')}/${st.cohort_number}/me`;
    const isCritical = st.risk_status === 'critical';

    const { text, html } = isCritical
      ? renderEmail({
          heading: `Cohort ${st.cohort_number} — your attendance update`,
          paragraphs: [
            `Hi ${firstName},`,
            `We noticed you've missed ${st.missed_count} sessions so far. Certificate eligibility requires ${st.cert_attendance_pct}% attendance, and you're currently at ${st.attendance_pct ?? '—'}%.`,
            `This isn't a judgment — life happens. But we want you to know where you stand so you can make an informed decision about the next few weeks.`,
            `If you can attend the remaining sessions (or watch the recordings within the week), you're still on track. Open your status page to see the exact path forward.`,
            `If you've decided to withdraw, just reply to this email — we'll mark it cleanly and you can re-apply for a future cohort with no hard feelings.`,
          ],
          cta: { label: 'Open my status →', url: portalUrl },
          footer: 'Reply to this email if you want to talk about it.',
        })
      : renderEmail({
          heading: `Cohort ${st.cohort_number} — quick check-in`,
          paragraphs: [
            `Hi ${firstName},`,
            `You've missed ${st.missed_count} session${st.missed_count === 1 ? '' : 's'} so far. Still well within reach of the ${st.cert_attendance_pct}% threshold, but worth flagging now rather than later.`,
            `If something's getting in the way of attending, replies to this email go straight to the organisers — we're happy to brainstorm.`,
          ],
          cta: { label: 'See my attendance →', url: portalUrl },
        });

    try {
      await sendMail({
        to: st.email,
        subject: isCritical
          ? `Cohort ${st.cohort_number}: where you stand on attendance`
          : `Cohort ${st.cohort_number}: a quick attendance heads-up`,
        text, html,
      });
      sent++;

      // Record the notification so we don't re-send next Wednesday.
      await audit({
        action:    'atrisk_notified',
        actorKind: 'system',
        actorEmail: st.email,
        targetType: 'enrolment',
        targetId:   st.enrolment_id,
        payload:    { level: st.risk_status, missed: st.missed_count, pct: st.attendance_pct },
      });
    } catch (err) {
      console.error(`At-risk send to ${st.email} failed:`, err.message);
      failed++;
    }
    await new Promise(res => setTimeout(res, INTER_EMAIL_MS));
  }

  console.log(`At-risk done. Sent: ${sent}, skipped (recent): ${skipped}, failed: ${failed}`);
  return { statusCode: 200, body: `sent=${sent} skipped=${skipped} failed=${failed}` };
};

// Wednesday at 09:00 UTC = 10:00 Lagos.
export const config = {
  schedule: '0 9 * * 3',
};
