/**
 * send-bulk-background.mjs
 *
 * Netlify Background Function. Files ending in `-background.mjs` get
 * a 15-minute runtime instead of 10 seconds, and return immediately
 * to the caller with a 202 Accepted while the work continues.
 *
 * Used by:
 *   - applications-review.mjs when bulk-accepting > 20 applicants
 *     (synchronous Gmail sends would time out the parent function)
 *   - any future bulk email job
 *
 * Inputs (POST JSON):
 *   {
 *     kind: 'application_status',  // template selector
 *     status: 'accepted' | 'rejected' | 'waitlisted',
 *     cohortNumber: 10,
 *     recipients: [
 *       { email, firstName, applicationId },
 *       ...
 *     ],
 *     customMessage: '...'          // optional override paragraph
 *   }
 *
 * Auth: same session check as the parent. The parent verifies the
 * organiser before queuing; this function trusts that since it's
 * only reachable via the redirect from the parent.
 *
 * Audit: each successful send writes a 'bulk_email_sent' row; each
 * failure writes 'bulk_email_failed'. So you can grep audit_log after
 * the job to see what happened.
 */

import { getSession }      from './_lib/auth.mjs';
import { sendMail, renderEmail } from './_lib/email.mjs';
import {
  json, preflight, parseJsonBody, requireEnv, audit,
} from './_lib/http.mjs';

const INTER_EMAIL_MS = 700;          // ~85/min — under Gmail rate-limit

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const envCheck = requireEnv(['SESSION_SECRET', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PORTAL_BASE_URL']);
  if (envCheck) return envCheck;

  const session = getSession(event);
  if (!session || session.kind !== 'organiser') {
    return json(401, { error: 'Not signed in as an organiser' });
  }

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (body.kind !== 'application_status') {
    return json(400, { error: 'Unknown kind' });
  }
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return json(400, { error: 'recipients is required' });
  }

  const status        = String(body.status || '');
  const cohortNumber  = Number(body.cohortNumber);
  const customMessage = body.customMessage ? String(body.customMessage) : null;

  if (!['accepted', 'rejected', 'waitlisted'].includes(status)) {
    return json(400, { error: 'Invalid status' });
  }

  // For a background function we return 202 immediately. The work
  // proceeds. Netlify scrapes stdout/stderr into function logs so
  // progress is visible there.
  //
  // We can't await this and also return early — that would block.
  // Instead: kick off the work, return immediately.
  doWork(body.recipients, status, cohortNumber, customMessage, session.email)
    .catch(err => console.error('Background send job crashed:', err));

  return {
    statusCode: 202,
    body: JSON.stringify({ ok: true, queued: body.recipients.length }),
  };
};

async function doWork(recipients, status, cohortNumber, customMessage, actorEmail) {
  console.log(`Bulk ${status} email job: ${recipients.length} recipient(s)`);

  const portalUrl = `${process.env.PORTAL_BASE_URL.replace(/\/$/, '')}/${cohortNumber}/`;
  let sent = 0, failed = 0;

  for (const r of recipients) {
    const firstName = r.firstName || r.email.split('@')[0];

    const { text, html } = status === 'accepted'
      ? renderEmail({
          heading: `You're in — welcome to Cohort ${cohortNumber}`,
          paragraphs: [
            `Hi ${firstName},`,
            `Great news — your application to TRI AI Saturdays Cohort ${cohortNumber} has been accepted.`,
            customMessage || `The cohort starts soon. Open the portal below to complete onboarding, see the schedule, and meet the community.`,
          ],
          cta: { label: 'Open the cohort portal →', url: portalUrl },
          footer: 'Reply to this email if you can no longer commit to the schedule, or with any questions.',
        })
      : status === 'rejected'
      ? renderEmail({
          heading: `Cohort ${cohortNumber} — application update`,
          paragraphs: [
            `Hi ${firstName},`,
            `Thank you for applying to Cohort ${cohortNumber}. We received many strong applications this round and were not able to offer you a place this time.`,
            customMessage || `We genuinely hope you'll apply again. Your application stays in our system, and our next cohort applications open later this year — we'll let you know.`,
          ],
          footer: 'TRI AI Saturdays — cohorts@tri-ai.org',
        })
      : renderEmail({
          heading: `Cohort ${cohortNumber} — application update`,
          paragraphs: [
            `Hi ${firstName},`,
            customMessage || `Your application has been waitlisted. We'll be in touch if a place opens up.`,
          ],
        });

    try {
      await sendMail({
        to: r.email,
        subject: status === 'accepted'
          ? `🎉 You're accepted into Cohort ${cohortNumber}`
          : `Cohort ${cohortNumber} application update`,
        text, html,
      });
      sent++;
      await audit({
        action:    'bulk_email_sent',
        actorEmail,
        actorKind: 'system',
        targetType: 'application',
        targetId:   r.applicationId,
        payload:    { kind: 'application_status', status, email: r.email },
      });
    } catch (err) {
      failed++;
      console.error(`Bulk send to ${r.email} failed:`, err.message);
      await audit({
        action:    'bulk_email_failed',
        actorEmail,
        actorKind: 'system',
        targetType: 'application',
        targetId:   r.applicationId,
        payload:    { kind: 'application_status', status, email: r.email, error: err.message },
      });
    }
    await new Promise(res => setTimeout(res, INTER_EMAIL_MS));
  }

  console.log(`Bulk ${status} done. Sent: ${sent}, failed: ${failed}`);
}
