-- ============================================================
-- 004 - Attendance, auth tokens, audit log
--
-- Operational tables. These get the most writes during a running
-- cohort. Indexed for the dashboard queries that organisers run
-- weekly.
-- ============================================================

-- ── attendance ────────────────────────────────────────────────
-- The thing students fill in every Saturday. One row per
-- (enrolment, session). A re-submission overwrites the previous
-- row (UPSERT on the unique key) so a student can correct their
-- feedback without us getting duplicate rows.
--
-- The (enrolment_id, session_id) key — rather than (email, week) —
-- is what gives us clean cross-cohort behaviour. A withdrawn
-- student's attendance stays attached to THIS cohort's enrolment;
-- their re-enrolment in a future cohort starts fresh.
CREATE TABLE IF NOT EXISTS attendance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id         uuid NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  session_id           uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status               text NOT NULL
                        CHECK (status IN ('live','recording','missed','excused')),
  rating               integer
                        CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  feedback_positive    text,                   -- "what worked"
  feedback_question    text,                   -- "what's still unclear"
  -- Where did this record come from? self = student submitted via
  -- the check-in form. organiser = an organiser entered it manually
  -- (e.g. a student emailed to say they were sick). import = bulk
  -- import from a CSV.
  source               text NOT NULL DEFAULT 'self'
                        CHECK (source IN ('self','organiser','import')),
  -- When the student (or organiser) actually marked this.
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  -- When the row was last updated. Same value as submitted_at on
  -- first insert; later if they edit feedback.
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrolment_id, session_id)
);

CREATE TRIGGER attendance_updated_at
  BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_attendance_session_status
  ON attendance (session_id, status);
CREATE INDEX IF NOT EXISTS idx_attendance_enrolment
  ON attendance (enrolment_id);
-- Partial index for the at-risk query: only misses matter.
CREATE INDEX IF NOT EXISTS idx_attendance_misses
  ON attendance (enrolment_id) WHERE status = 'missed';


-- ── magic_link_tokens ─────────────────────────────────────────
-- One-time tokens for student/facilitator email-based sign-in.
-- The flow:
--   1. Student enters their email.
--   2. Server generates a random token, inserts row here, emails
--      a link of the form https://cohort.tri-ai.org/auth/callback?t=<token>.
--   3. Student clicks. Server looks up the token, marks consumed,
--      sets a session cookie (JWT signed with SESSION_SECRET).
--
-- We store the SHA-256 hash of the token, not the token itself,
-- so a database leak doesn't yield usable tokens. (The same pattern
-- as how passwords are stored.)
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The hash of the token. The actual token is sent by email and
  -- never stored.
  token_hash      text NOT NULL UNIQUE,
  -- Who the token was issued for. Stored as email rather than
  -- person_id because the magic-link endpoint may be hit by an
  -- email that doesn't have a people row yet (a freshly-accepted
  -- applicant who hasn't logged in).
  email           citext NOT NULL,
  -- Optional binding: if the link is for a specific cohort
  -- ("View your status for Cohort 10"), this scopes the resulting
  -- session.
  cohort_id       uuid REFERENCES cohorts(id) ON DELETE CASCADE,
  -- Expiry — magic links should be short-lived. Default 30 minutes
  -- gives a comfortable margin for slow email delivery.
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  -- IP and User-Agent of the request that generated the token,
  -- and of the request that consumed it. Doesn't gate consumption
  -- (forcing same-IP would break mobile users on cellular networks)
  -- but is recorded for forensics if a token gets phished.
  request_ip      inet,
  request_ua      text,
  consume_ip      inet,
  consume_ua      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_magic_link_email_pending
  ON magic_link_tokens (email)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_magic_link_expiry
  ON magic_link_tokens (expires_at)
  WHERE consumed_at IS NULL;


-- ── organisers ────────────────────────────────────────────────
-- Per-organiser logins. Distinct from enrolments because
-- organisers aren't tied to one cohort — they have access across
-- all cohorts. Stores a bcrypt hash, not a plaintext password.
--
-- For 2-5 organisers we don't need a full role/permissions matrix.
-- Two levels: 'admin' (can do anything) and 'organiser' (can do
-- everything except create/delete other organiser accounts).
CREATE TABLE IF NOT EXISTS organisers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                citext UNIQUE NOT NULL,
  password_hash        text NOT NULL,
  name                 text NOT NULL,
  role                 text NOT NULL DEFAULT 'organiser'
                        CHECK (role IN ('admin','organiser')),
  active               boolean NOT NULL DEFAULT true,
  last_login_at        timestamptz,
  -- Failed-login throttle. Auth code increments fail_count on
  -- wrong password and refuses logins for 15 minutes once
  -- fail_count >= 5. Successful login zeroes it out.
  fail_count           integer NOT NULL DEFAULT 0,
  fail_lockout_until   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organisers_updated_at
  BEFORE UPDATE ON organisers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── audit_log ─────────────────────────────────────────────────
-- Every state-changing organiser action gets a row here. This is
-- the answer to "who accepted Tunde?" and "who marked Aisha as
-- excused for Week 5?" — questions that come up at least once per
-- cohort and that an unaudited spreadsheet can never answer.
--
-- The schema is loose on purpose: action is a free-text verb,
-- payload is jsonb. We pay for query convenience with one indexed
-- column per axis we'd want to filter on.
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_email   citext,                       -- NULL for system actions (cron)
  actor_kind    text NOT NULL DEFAULT 'organiser'
                 CHECK (actor_kind IN ('organiser','student','facilitator','system','import')),
  action        text NOT NULL,                -- e.g. 'accept_application', 'mark_attendance'
  target_type   text,                         -- 'application' | 'enrolment' | 'attendance' | ...
  target_id     uuid,
  cohort_id     uuid REFERENCES cohorts(id) ON DELETE SET NULL,
  ip            inet,
  user_agent    text,
  payload       jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log (actor_email, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_cohort  ON audit_log (cohort_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log (action, occurred_at DESC);


-- ── import_batches ────────────────────────────────────────────
-- Each application CSV import gets a row here. Lets us undo a
-- bad import wholesale: a runaway nightly job creates 600 dupe
-- rows, you delete by batch_id.
CREATE TABLE IF NOT EXISTS import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL
                 CHECK (kind IN ('applications','attendance','people')),
  cohort_id     uuid REFERENCES cohorts(id) ON DELETE SET NULL,
  imported_by   citext NOT NULL,            -- organiser email
  imported_at   timestamptz NOT NULL DEFAULT now(),
  source_name   text,                       -- the CSV filename
  rows_total    integer NOT NULL DEFAULT 0,
  rows_inserted integer NOT NULL DEFAULT 0,
  rows_updated  integer NOT NULL DEFAULT 0,
  rows_skipped  integer NOT NULL DEFAULT 0,
  notes         text
);

-- Tag every inserted row with the batch that produced it. Used
-- only for application imports right now; other types can follow
-- the same pattern.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_applications_import_batch
  ON applications (import_batch_id);


INSERT INTO schema_migrations (filename)
VALUES ('004_attendance_auth_audit.sql')
ON CONFLICT (filename) DO NOTHING;
