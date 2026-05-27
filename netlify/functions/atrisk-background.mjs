/**
 * atrisk-background.mjs
 *
 * Background Function. Invoked by cron-hourly when the at-risk window
 * matches a running cohort. Sends one warning email per at-risk
 * student (warning OR critical level), with deduplication against
 * recent notifications to avoid spamming the same student weekly
 * at the same risk level.
 */

import { query }            from './_lib/db.mjs';
import { newMagicToken }    from './_lib/auth.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import { audit, requireEnv } from './_lib/http.mjs';

const INTER_EMAIL_MS         = 1200;     // ~50/min
const MAX_PER_RUN            = 700;
const TOKEN_TTL_HOURS        = 36;
const RECENT_NOTIFY_DAYS     = 14;       // don't re-notify same level

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  const expected = process.env.SYSTEM_CRON_SECRET || '';
  const got      = event.headers['x-system-cron'] || event.headers['X-System-Cron'] || '';
  if (!expected || got !== expected) {
    console.warn('atrisk-background: rejected — bad or missing x-system-cron');
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
  if (!cohortId || !cohortNumber) return { statusCode: 400, body: 'missing fields' };

  console.log(`atrisk-background: cohort ${cohortNumber}`);

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
        s.missed_count DESC
      LIMIT $2`,
    [cohortId, MAX_PER_RUN]
  );

  const recent = await query(
    `SELECT target_id::text, payload FROM audit_log
      WHERE action = 'atrisk_notified'
        AND occurred_at > now() - interval '${RECENT_NOTIFY_DAYS} days'
        AND cohort_id = $1`,
    [cohortId]
  );
  const notified = new Set();
  for (const r of recent) {
    const lvl = r.payload?.level;
    if (lvl) notified.add(`${r.target_id}|${lvl}`);
  }

  let sent = 0, failed = 0;

  const portalBase = process.env.PORTAL_BASE_URL.replace(/\/$/, '');
  const mePath = `/${cohortNumber}/me`;
  const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);

  for (const st of atRisk) {
    const key = `${st.enrolment_id}|${st.risk_status}`;
    if (notified.has(key)) continue;

    const firstName = st.first_name || st.email.split('@')[0];
    const isCritical = st.risk_status === 'critical';

    const { token, tokenHash } = newMagicToken();
    try {
      await query(
        `INSERT INTO magic_link_tokens (token_hash, email, cohort_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [tokenHash, st.email, cohortId, tokenExpiresAt]
      );
    } catch (err) {
      console.error(`  token mint failed for ${st.email}:`, err.message);
      failed++;
      continue;
    }
    const portalUrl = `${portalBase}/auth/callback?t=${encodeURIComponent(token)}` +
                      `&next=${encodeURIComponent(mePath)}`;

    const { text, html } = isCritical
      ? renderEmail({
          heading: `Cohort ${cohortNumber} — your attendance update`,
          paragraphs: [
            `Hi ${firstName},`,
            `We noticed you've missed ${st.missed_count} sessions so far. Certificate eligibility requires ${st.cert_attendance_pct}% attendance, and you're currently at ${st.attendance_pct ?? '—'}%.`,
            `This isn't a judgment — life happens. But we want you to know where you stand so you can decide about the next few weeks.`,
            `Tap below to open your status page (no need to sign in, this link does it for you).`,
          ],
          cta: { label: 'Open my status →', url: portalUrl },
          footer: 'Reply to this email if you want to talk about it.',
        })
      : renderEmail({
          heading: `Cohort ${cohortNumber} — quick check-in`,
          paragraphs: [
            `Hi ${firstName},`,
            `You've missed ${st.missed_count} session${st.missed_count === 1 ? '' : 's'} so far. Still well within reach of the ${st.cert_attendance_pct}% threshold, but worth flagging now.`,
            `If something's getting in the way, replies to this email go straight to the organisers.`,
          ],
          cta: { label: 'See my attendance →', url: portalUrl },
        });

    try {
      await sendMail({
        to: st.email,
        subject: isCritical
          ? `Cohort ${cohortNumber}: where you stand on attendance`
          : `Cohort ${cohortNumber}: a quick attendance heads-up`,
        text, html,
      });
      sent++;
      await audit({
        action:    'atrisk_notified',
        actorKind: 'system',
        actorEmail: st.email,
        cohortId,
        targetType: 'enrolment',
        targetId:   st.enrolment_id,
        payload:    { level: st.risk_status, missed: st.missed_count, pct: st.attendance_pct },
      });
    } catch (err) {
      console.error(`  at-risk send to ${st.email} failed:`, err.message);
      failed++;
    }
    await new Promise(res => setTimeout(res, INTER_EMAIL_MS));
  }

  await audit({
    action:    'cron_atrisk_done',
    actorKind: 'system',
    cohortId,
    payload:   { sent, failed },
  });

  console.log(`atrisk-background done. Sent: ${sent}, failed: ${failed}`);
  return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
};
