Patch: fix "syntax error at or near current_role" in migration 003

THE BUG
=======
current_role is a reserved keyword in Postgres — it's the function
that returns the current session role (try SELECT current_role).
Postgres refuses to accept it as an unquoted column name.

THE FIX
=======
Rename the column current_role → applicant_role everywhere. The new
name is also clearer (it's the applicant's professional role, not
anything DB-related).

FILES IN THIS ZIP
=================
The directory structure mirrors your repo. Unzip into the repo root
and the four files drop into the right places:

  db/migrations/003_applications_enrolments.sql
  netlify/functions/_lib/application-mapping.mjs
  netlify/functions/applications-import.mjs
  netlify/functions/applications-review.mjs

TO APPLY
========

1. Unzip into your repo root, overwriting the four files.

   On macOS/Linux:
     cd path/to/your/cohort-tri-ai-v2
     unzip -o /path/to/current-role-fix.zip

2. Re-run migrations against your DB:


    DATABASE_URL='postgresql://admin:PASWSORD@2.tcp.ngrok.io:1234/cohort10' \
    DATABASE_SSL=false \
      npm run db:migrate

   Expected output:
     skip   001_extensions.sql (already applied)
     skip   002_people_cohorts.sql (already applied)
     apply  003_applications_enrolments.sql
     apply  004_attendance_auth_audit.sql
     apply  005_views.sql

   Your earlier failed run rolled back cleanly (transaction-per-file),
   so there's no stale state to clean up — 001 and 002 are already in
   schema_migrations and the runner will skip them.

3. Then run seed and create-organiser as before:

     DATABASE_URL='...' npm run db:seed
     DATABASE_URL='...' npm run db:create-organiser

4. Commit and push the four updated files so Netlify rebuilds with
   the matching application code:

     git add db/migrations/003_applications_enrolments.sql \
             netlify/functions/_lib/application-mapping.mjs \
             netlify/functions/applications-import.mjs \
             netlify/functions/applications-review.mjs
     git commit -m "Rename current_role to applicant_role (PG reserved word)"
     git push
