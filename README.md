# cohort.tri-ai.org

The TRI AI Saturdays cohort portal: applications, attendance, dashboards, and student-facing pages for active cohorts. Separate from the main marketing site at `tri-ai.org`.

## What's in this drop (Phase 2)

This is **backend-only**: database schema + Netlify Functions + scripts + docs. The Astro UI pages from Phase 1 are still here (cohort cards, schedule, check-in form), but the new pages that consume the new APIs (admin dashboards, /me, facilitator) ship in the next drop.

You can deploy this *as is* and the existing student-facing pages keep working through the new Postgres-backed attendance API. The admin UI sits at HTTP-API level until next drop — usable via curl/Postman if you need to import applications right now.

### What's new vs Phase 1

| Area               | Phase 1                              | Phase 2 (this)                                    |
|--------------------|--------------------------------------|---------------------------------------------------|
| Data store         | Google Sheets (via Apps Script)      | Self-hosted Postgres                              |
| Attendance         | Anonymous form → spreadsheet         | Authenticated upsert against `attendance` table   |
| Applications       | Google Forms only                    | Google Forms + CSV import → reviewable in DB      |
| Organiser auth     | Shared dashboard password            | Per-organiser logins (scrypt, lockout, audit log) |
| Student auth       | (none)                               | Magic-link via Gmail SMTP                         |
| Cross-cohort data  | Manual lookups                       | One `people` row, many `enrolments`               |
| Audit trail        | None                                 | `audit_log` table; every mutation recorded        |
| At-risk detection  | Computed in frontend JS              | `student_attendance_summary` view in SQL          |

## Repo layout

```
/
├── db/
│   ├── migrations/             001..005 SQL — idempotent
│   ├── run-migrations.mjs      apply migrations
│   ├── seed.mjs                seed cohorts/sessions from markdown
│   └── create-organiser.mjs    interactive: create first admin
├── netlify/functions/
│   ├── _lib/                   db, auth, http, email, mapping helpers
│   ├── auth-request-link.mjs   magic link request
│   ├── auth-callback.mjs       magic link consume → session cookie
│   ├── auth-organiser-login.mjs  organiser email+password
│   ├── attendance-api.mjs      verify + submit, Postgres-backed
│   ├── applications-import.mjs CSV import with preview
│   ├── applications-review.mjs list/detail/set_status, with email
│   ├── dashboard-api.mjs       organiser data views
│   └── student-me.mjs          /me page data
├── src/                        Astro pages (Phase 1; UI for new pages
│                                comes in next drop)
├── netlify.toml                CSP, redirects, headers
├── package.json                deps: astro, pg, nodemailer, csv-parse
└── docs/DEPLOY.md              deployment runbook (READ THIS FIRST)
```

## Quickstart

```bash
npm install
# Set env vars — see docs/DEPLOY.md for the full list
export DATABASE_URL='postgresql://cohort_app:PWD@db.tri-ai.org:5432/cohort_portal?sslmode=require'
export SESSION_SECRET=$(openssl rand -hex 32)
export PORTAL_BASE_URL=https://cohort.tri-ai.org
export GMAIL_USER=cohorts@tri-ai.org
export GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx'

npm run db:migrate            # one-time, idempotent
npm run db:seed               # cohort + sessions from markdown
npm run db:create-organiser   # interactive — first admin

# Deploy
git push origin main          # Netlify auto-builds
```

Full instructions, troubleshooting, runbook → `docs/DEPLOY.md`.

## Status

- ✅ Phase 0: Apps Script hardening (in original prototype, not this repo)
- ✅ Phase 1: Standalone subdomain + brand alignment
- ✅ Phase 2 backend (this drop): schema, auth, APIs, scripts, docs
- ⏳ Phase 2 UI (next drop): admin dashboards, /me, facilitator, sign-in pages
- ⏳ Phase 3: cron jobs (weekly reminders, at-risk alerts), background-function bulk email
# cohort-management
