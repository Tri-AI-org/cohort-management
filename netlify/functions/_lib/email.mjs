/**
 * _lib/email.mjs — outbound email via Gmail SMTP.
 *
 * Uses nodemailer with Gmail's SMTP relay. Requires:
 *   GMAIL_USER         — the address to send from (e.g.
 *                        cohorts@tri-ai.org if it's a Workspace
 *                        account; otherwise the gmail.com address)
 *   GMAIL_APP_PASSWORD — a 16-char App Password generated at
 *                        myaccount.google.com/apppasswords. NOT
 *                        the user's actual login password — that
 *                        won't work for SMTP at all on
 *                        2FA-enabled accounts.
 *
 * Quota: Google Workspace = ~2000 messages/day per sending account.
 * Personal Gmail = ~500/day. For 3,000 students this means a single
 * "send to everyone" blast doesn't fit in one day on the free tier
 * of Workspace, and definitely doesn't on personal Gmail. The
 * weekly reminder function batches + spaces sends; for one-off
 * blasts to the whole cohort, split across two days or BCC. The
 * deploy doc has a quota table in the runbook section.
 *
 * Reliability: a Gmail SMTP send takes 1-3 seconds. Netlify
 * Functions time out at 10s on the free plan, 26s on Pro. Sending
 * one email per invocation fits comfortably; sending 50 per
 * invocation does not. The cron function fans out one Lambda per
 * recipient using Netlify Background Functions for the bulk path.
 */

import nodemailer from 'nodemailer';

let _transporter = null;

function transporter() {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,                       // TLS, not STARTTLS
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    // Pool connections to amortise the TLS handshake across the
    // few sends that happen within one Lambda invocation. Each
    // container only keeps 2 connections.
    pool: true,
    maxConnections: 2,
    // Refuse to wait forever for Gmail.
    socketTimeout: 8_000,
  });

  return _transporter;
}

/**
 * Send one email. Throws on transport failure (so the caller can
 * decide whether to retry or surface the error). Returns the
 * SMTP messageId on success.
 */
export async function sendMail({ to, subject, text, html, replyTo }) {
  const from = process.env.GMAIL_FROM_NAME
    ? `"${process.env.GMAIL_FROM_NAME}" <${process.env.GMAIL_USER}>`
    : process.env.GMAIL_USER;

  const info = await transporter().sendMail({
    from,
    to,
    subject,
    text,                                  // plaintext fallback always
    html,                                  // optional HTML version
    replyTo: replyTo || 'cohorts@tri-ai.org',
  });

  return info.messageId;
}

/**
 * Template helper: produce a clean, brand-aware HTML email body
 * from a heading + paragraphs + a CTA button. Keeps every outgoing
 * email visually consistent without making the caller assemble
 * HTML.
 */
export function renderEmail({ heading, paragraphs = [], cta = null, footer = null }) {
  const safe = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const paraHtml = paragraphs
    .map(p => `<p style="margin:0 0 16px;color:#333333;line-height:1.6;font-size:15px;">${safe(p)}</p>`)
    .join('\n');

  const ctaHtml = cta
    ? `<p style="margin:24px 0;">
         <a href="${safe(cta.url)}"
            style="display:inline-block;background:#FE6612;color:#ffffff;text-decoration:none;
                   font-weight:600;padding:12px 24px;border-radius:6px;font-size:15px;">
           ${safe(cta.label)}
         </a>
       </p>`
    : '';

  const footerHtml = footer
    ? `<p style="margin-top:32px;padding-top:16px;border-top:1px solid #eeeeee;
                color:#888888;font-size:13px;line-height:1.5;">${safe(footer)}</p>`
    : '';

  // Plaintext alternative for clients that don't render HTML.
  const text = [
    heading,
    '',
    ...paragraphs,
    cta ? `\n${cta.label}: ${cta.url}` : '',
    footer ? `\n${footer}` : '',
    '',
    '—',
    'TRI AI Saturdays  ·  cohorts@tri-ai.org  ·  https://tri-ai.org',
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:32px;border:1px solid #eeeeee;">
    <h1 style="margin:0 0 16px;color:#141414;font-size:22px;font-weight:700;letter-spacing:-0.01em;">
      ${safe(heading)}
    </h1>
    ${paraHtml}
    ${ctaHtml}
    ${footerHtml}
  </div>
  <p style="text-align:center;margin:16px 0;color:#aaaaaa;font-size:12px;">
    TRI AI Saturdays  ·  <a href="https://tri-ai.org" style="color:#aaaaaa;">tri-ai.org</a>
  </p>
</body></html>`;

  return { text, html };
}
