# Deploying cohort.tri-ai.org — Phase 2 (Postgres)

This is the runbook for getting Phase 2 live. It assumes Phase 1 (the standalone Astro site at `cohort.tri-ai.org` with Phase 0's signed-cookie proxy) is already deployed; if not, see the earlier `PHASE-0-README.md` and the Phase 1 deploy notes first.

> **Reading order.** Sections 1–4 you do once. Sections 5–6 you do on every code deploy. Section 7 is the operational runbook you'll come back to.

---

## 1 · Set up your homelab Postgres

You said you have a Postgres instance in your homelab. The portal needs:

- **Postgres 14 or newer.** 16 or 17 is ideal. Migrations use `gen_random_uuid()` (pgcrypto), `citext`, and `jsonb` — all standard.
- A dedicated database for this app (don't share with other projects).
- A dedicated role with login + write access to that database only.

Quick start (adjust for your distro):

```sql
-- as postgres superuser:
CREATE DATABASE cohort_portal;
CREATE ROLE cohort_app LOGIN PASSWORD 'use-a-long-random-password-here';
GRANT CONNECT ON DATABASE cohort_portal TO cohort_app;
\c cohort_portal
GRANT USAGE ON SCHEMA public TO cohort_app;
GRANT CREATE ON SCHEMA public TO cohort_app;
-- The migrations will own their objects; cohort_app needs CREATE
-- to install pgcrypto + citext on first run. If you prefer, install
-- those extensions as the superuser first, then revoke CREATE.
```

Test the role can connect from inside your homelab:

```bash
psql "postgresql://cohort_app:PASSWORD@localhost:5432/cohort_portal" -c 'SELECT 1'
```

---

## 2 · Expose Postgres to Netlify Functions

Netlify Functions execute on AWS Lambda. They need TCP access to your Postgres. **Pick exactly one of these:**

### Option A — Cloudflare Tunnel (recommended)

Zero firewall config, end-to-end TLS, free at any sensible scale.

1. Install `cloudflared` on the homelab box.
2. `cloudflared tunnel login`, then `cloudflared tunnel create cohort-portal`.
3. Add a CNAME in Cloudflare DNS: `db.tri-ai.org` → `<tunnel-uuid>.cfargotunnel.com`.
4. Edit `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: <tunnel-uuid>
   credentials-file: /home/you/.cloudflared/<tunnel-uuid>.json
   ingress:
     - hostname: db.tri-ai.org
       service: tcp://localhost:5432
     - service: http_status:404
   ```

5. `sudo cloudflared service install` so it persists across reboots.
6. From Netlify Functions you'll connect through Cloudflare's edge using their `pg`-compatible Worker-style URL — **or more simply**, expose it as a TCP proxy and accept the self-signed cert (we already handle this in `_lib/db.mjs`).

Connection string: `postgresql://cohort_app:PASSWORD@db.tri-ai.org:5432/cohort_portal?sslmode=require`

### Option B — Direct exposure with a real cert

If you'd rather not run a tunnel:

1. Port-forward 5432 on your router → your DB host.
2. DNS: `db.tri-ai.org` A-records to your public IP (or use DDNS).
3. On the DB host, get a Let's Encrypt cert (e.g. via `certbot --standalone`).
4. In `postgresql.conf`: `ssl = on`, `ssl_cert_file = '/path/cert.pem'`, `ssl_key_file = '/path/key.pem'`.
5. In `pg_hba.conf`: require `hostssl` for the `cohort_app` role and the Netlify IP range. Netlify doesn't publish a stable IP range, so realistically this means `0.0.0.0/0` — which means **install fail2ban** and tighten `pg_hba.conf` to require strong passwords + cert-based auth where possible.

Set `DATABASE_SSL_STRICT=true` for option B (you have a real cert; reject unknown CAs).

### Option C — Tailscale

`pg` can't reach a Tailnet from inside a Lambda. Don't try this.

---

## 3 · Set up Gmail for SMTP

Magic-link emails go via Gmail's SMTP relay.

1. Pick a sending address. Either a Google Workspace mailbox (recommended — 2000/day, looks like `cohorts@tri-ai.org`) or a personal Gmail (500/day, looks like `someone@gmail.com`).
2. **Turn on 2FA** on the Google account. App Passwords don't work without it.
3. Go to <https://myaccount.google.com/apppasswords> → create one for "Mail" / "Other (cohort.tri-ai.org)".
4. Copy the 16-character password somewhere safe. **You can't view it again** — if you lose it, generate a new one.

> **Quota note.** A "send to everyone" blast to 3,000 students doesn't fit in one Workspace day. The weekly reminder cron paces sends. For one-off bulk messages, either split across two days or use the regular Gmail web UI with BCC.

---

## 4 · Configure Netlify env vars

In Netlify UI: **Site settings → Environment variables**, add:

| Key                       | Example                                              | Notes |
|---------------------------|------------------------------------------------------|-------|
| `DATABASE_URL`            | `postgresql://cohort_app:PWD@db.tri-ai.org:5432/cohort_portal?sslmode=require` | The full PG connection string. |
| `DATABASE_SSL_STRICT`     | `false` for Cloudflare Tunnel, `true` for Option B   | Whether to reject unknown CAs. |
| `SESSION_SECRET`          | (32+ random hex chars, e.g. from `openssl rand -hex 32`) | Signs session cookies. Rotating this kicks everyone out — that's fine. |
| `PORTAL_BASE_URL`         | `https://cohort.tri-ai.org`                          | Used to build magic-link URLs. No trailing slash. |
| `GMAIL_USER`              | `cohorts@tri-ai.org`                                 | The From: address. |
| `GMAIL_APP_PASSWORD`      | 16-char value from step 3                            | Don't paste your real Google password. |
| `GMAIL_FROM_NAME`         | `TRI AI Saturdays`                                   | What recipients see in their inbox list. |

> ⚠ The Phase 0 vars (`PROXY_API_KEY`, `STUDENT_VERIFY_KEY`, etc.) are no longer needed. You can delete them, OR leave them set — they're harmless after the Phase 0 function file was removed.

---

## 5 · Run migrations + seed

From your local machine, with `DATABASE_URL` pointing at the homelab DB (you'll likely want to use the Cloudflare Tunnel hostname so you're testing the exact path Netlify uses):

```bash
npm install
DATABASE_URL='postgresql://cohort_app:PWD@db.tri-ai.org:5432/cohort_portal?sslmode=require' \
  npm run db:migrate
# applies 001..005 once, idempotent — safe to re-run

DATABASE_URL=... npm run db:seed
# reads src/content/cohorts/*.md and upserts cohort + sessions rows

DATABASE_URL=... npm run db:create-organiser
# interactive — creates the first admin account
# Email + name + role (pick 'admin' for the first one) + password
# Password must be 12+ chars. Use a manager.
```

After this you should be able to:
1. Open `https://cohort.tri-ai.org/admin/login` (UI page coming in next drop)
2. Sign in with the organiser email + password you just set
3. See an empty dashboard (no applications imported yet)

---

## 6 · Deploy the site

```bash
git add -A
git commit -m "Phase 2: Postgres-backed portal"
git push origin main      # → Netlify auto-deploys
```

Check Netlify's deploy log for build success. Then smoke-test:

- `https://cohort.tri-ai.org/.netlify/functions/auth-organiser-login` — POST should 400 ("Email and password are required"). If you get 500, the function can't reach the DB.
- `https://cohort.tri-ai.org/10/check-in` — should render the attendance form.
- Sign in as your organiser, attempt to import a CSV.

---

## 7 · Operational runbook

### Importing applications

1. In Google Sheets (responses sheet): **File → Download → Comma-separated values**.
2. Open `https://cohort.tri-ai.org/<n>/admin/import` (UI page coming).
3. Upload the CSV. You'll see a preview: total rows, new vs returning, duplicates, errors.
4. Click "Commit" to write. Atomic — if anything fails, nothing's written.
5. Undo a bad import:
   ```sql
   -- Find the batch
   SELECT id, imported_at, source_name, rows_inserted, rows_updated
     FROM import_batches WHERE cohort_id = (SELECT id FROM cohorts WHERE number = 10)
     ORDER BY imported_at DESC LIMIT 5;
   -- Delete rows from a specific batch:
   DELETE FROM applications WHERE import_batch_id = '<batch-uuid>';
   ```

### Adding an organiser

`DATABASE_URL=... npm run db:create-organiser` — pick role `organiser` for teammates (only `admin` can create more organisers).

### Resetting a forgotten password

Same script. It detects an existing email and offers to reset.

### When a student withdraws mid-cohort

In the admin UI (or directly in SQL):
```sql
UPDATE enrolments
   SET status = 'withdrawn', withdrawn_at = now(),
       left_week = (SELECT week FROM current_cohort_week WHERE cohort_id = …)
 WHERE person_id = (SELECT id FROM people WHERE email = '…') AND cohort_id = …;
```
Their past attendance stays. Future weeks no longer count for them.

### Gmail send-quota warnings

If you see `set_status: N emails queued — Gmail SMTP may not finish in time` in function logs, you exceeded the soft limit of 20 emails per single invocation. Either:
- Bulk-accept in smaller batches (50 at a time), or
- Set up a Netlify Background Function variant (next iteration).

### Backups

Daily `pg_dump` on the homelab. Cron job:
```bash
0 4 * * * pg_dump -Fc -d cohort_portal -f /backup/cohort-$(date +\%F).dump
```
Keep 30 days. Test restore quarterly.

### Rotating SESSION_SECRET

Generate a new value, set in Netlify env, redeploy. Every signed cookie immediately invalidates → every organiser must re-login and every student must re-magic-link. Do this if you suspect the secret was leaked (e.g. a `.env` file accidentally committed).

### Rotating GMAIL_APP_PASSWORD

Generate a new App Password, set in Netlify env, redeploy. Old password stops working within minutes.

---

## What still needs building (next message)

The Astro UI pages aren't in this drop — only the APIs are. Coming next:

- `/admin/login` — organiser sign-in page
- `/[n]/admin/` — overview dashboard
- `/[n]/admin/applications` — review + accept screen
- `/[n]/admin/import` — CSV import with preview
- `/[n]/me` — student status (attendance %, weeks, certificate path)
- `/[n]/facilitator` — facilitator submissions + feedback
- `/[n]/check-in` — migrated to use the new `attendance-api`
- `/signin` — student/facilitator email-entry page that triggers a magic link

Until then, the APIs are deployable and testable via curl/Postman; the UI just isn't built. This is a deliberate stop — you can verify the backend works against your homelab before the next layer goes on top.
