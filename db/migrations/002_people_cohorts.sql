-- ============================================================
-- 002 - Core entities: people and cohorts
--
-- These two tables are the foundation. Everything else references
-- them. They're separated from later migrations so that even a very
-- old backup can be brought up to a usable state for read-only
-- queries by running just migrations 001+002.
-- ============================================================

-- ── people ─────────────────────────────────────────────────────
-- A human, persistent across cohorts. The natural key is email,
-- which we store as citext so 'A@b.com' and 'a@b.com' collide.
-- We never delete from this table during normal operation; if a
-- person requests data deletion, we anonymise (clear PII columns
-- and replace email with a stub like 'deleted-<uuid>@removed.local').
--
-- Notes on each column:
--
--   github_url — kept as a free-text URL rather than just a
--     username, because not everyone uses GitHub. Some have GitLab,
--     Hugging Face profiles, or personal sites.
--
--   gender, age_range — collected on applications and copied here
--     because they describe the person, not the application. But
--     they're optional — applications without these still go
--     through; we don't gate acceptance on demographic data.
CREATE TABLE IF NOT EXISTS people (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext UNIQUE NOT NULL,
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  country         text,
  city            text,
  github_url      text,
  gender          text,
  age_range       text,
  -- A bit set: which programmes has this person ever touched? Lets
  -- us answer "show me all C9 alumni who also did C5" with one
  -- query and no joins. Strings of programme slugs separated by '|'.
  programme_tags  text DEFAULT '',
  notes           text,                  -- internal organiser notes
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER people_updated_at
  BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_people_email ON people (email);
CREATE INDEX IF NOT EXISTS idx_people_country ON people (country);


-- ── cohorts ────────────────────────────────────────────────────
-- One row per cohort. Most cohort-specific operational data
-- (schedule, thresholds, feature flags) lives here so that running
-- a new cohort is a row insert + markdown file, not a code change.
--
-- The schedule lives in BOTH cohort markdown frontmatter AND this
-- table. The markdown is the editorial source (humans edit it);
-- the table is the queryable source (functions read it). A small
-- sync function in the application keeps them aligned — see
-- netlify/functions/sync-cohort-schedule. They diverge gracefully:
-- the markdown wins for rendering, the table wins for joins.
CREATE TABLE IF NOT EXISTS cohorts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              integer UNIQUE NOT NULL,
  programme_slug      text NOT NULL DEFAULT 'tri-ai-saturdays',
  title               text,
  partner             text,
  status              text NOT NULL DEFAULT 'upcoming'
                       CHECK (status IN ('upcoming','running','completed','archived')),
  start_date          date,
  end_date            date,
  -- The break week (or NULL for cohorts with no break). Stored
  -- here for fast filtering in attendance/at-risk queries; the
  -- canonical truth is each session row's is_break flag.
  break_week          integer,
  total_weeks         integer NOT NULL DEFAULT 16,
  -- Certificate eligibility threshold. Default matches what we've
  -- been promising publicly ("attend at least 60%").
  cert_attendance_pct integer NOT NULL DEFAULT 60
                       CHECK (cert_attendance_pct BETWEEN 0 AND 100),
  -- At-risk thresholds. These are absolute absence counts, not
  -- percentages, because they're easier to reason about. ("Missed
  -- 3 sessions" is clearer than "below 80% attendance".)
  atrisk_warn_misses  integer NOT NULL DEFAULT 2,
  atrisk_crit_misses  integer NOT NULL DEFAULT 3,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER cohorts_updated_at
  BEFORE UPDATE ON cohorts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_cohorts_number ON cohorts (number);
CREATE INDEX IF NOT EXISTS idx_cohorts_status ON cohorts (status);


-- ── sessions ───────────────────────────────────────────────────
-- One row per (cohort, week). Independent table rather than a
-- JSON column on cohorts so we can FK from attendance and joined
-- queries stay fast.
CREATE TABLE IF NOT EXISTS sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id       uuid NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  week_number     integer NOT NULL,
  session_date    date NOT NULL,
  topic           text NOT NULL,
  is_break        boolean NOT NULL DEFAULT false,
  -- Facilitator: set when we know who's leading the session.
  -- NULL means "not yet assigned". References enrolments because
  -- a facilitator is a kind of enrolment role; defined in 003.
  facilitator_id  uuid, -- FK added in 003 after enrolments exists
  -- Material URLs. Filled in by facilitators via the facilitator
  -- dashboard or manually by organisers.
  slides_url      text,
  notebook_url    text,
  recording_url   text,
  readings_url    text,
  materials_status text NOT NULL DEFAULT 'pending'
                   CHECK (materials_status IN ('pending','submitted','approved','changes_requested')),
  materials_notes text,                   -- organiser feedback to facilitator
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, week_number)
);

CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_sessions_cohort ON sessions (cohort_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions (session_date);


INSERT INTO schema_migrations (filename)
VALUES ('002_people_cohorts.sql')
ON CONFLICT (filename) DO NOTHING;
