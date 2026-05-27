-- ============================================================
-- 003 - Applications, enrolments, teams
--
-- The lifecycle: someone submits the Google Form → we import →
-- `applications` row exists in 'submitted' state → an organiser
-- reviews and accepts → `enrolments` row is created → the person
-- becomes a student in the cohort.
--
-- An applicant who is rejected stays in `applications` with
-- status='rejected' forever, for analytics. They have no
-- `enrolments` row, so they appear in zero operational views.
-- ============================================================

-- ── applications ───────────────────────────────────────────────
-- Cohort-specific application data. The fields here mirror your
-- Google Form 1:1. When you change the form for Cohort 11, you
-- add columns here (with sensible defaults so old rows still
-- validate) — you do not modify or rename old columns.
--
-- The "form-shape evolves over time" problem is solved by keeping
-- the form_payload jsonb column: every imported row writes its
-- raw row to this column too. So even if your schema misses a
-- newly-added question in Cohort 12, the answer isn't lost — it's
-- in form_payload and we can backfill a real column later.
CREATE TABLE IF NOT EXISTS applications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  cohort_id             uuid NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted','reviewing','accepted','rejected','waitlisted','withdrawn')),
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  -- ── Application form fields, named to roughly match the Google Form ──
  team_id_raw           text,                  -- the Team_ID column from the form
  previous_participant  boolean,
  prereq_python         integer CHECK (prereq_python IS NULL OR prereq_python BETWEEN 1 AND 5),
  prereq_statistics     integer CHECK (prereq_statistics IS NULL OR prereq_statistics BETWEEN 1 AND 5),
  prereq_linear_alg     integer CHECK (prereq_linear_alg IS NULL OR prereq_linear_alg BETWEEN 1 AND 5),
  prereq_numpy_pandas   integer CHECK (prereq_numpy_pandas IS NULL OR prereq_numpy_pandas BETWEEN 1 AND 5),
  prereq_ml_concepts    integer CHECK (prereq_ml_concepts IS NULL OR prereq_ml_concepts BETWEEN 1 AND 5),
  applicant_role          text,
  job_title             text,
  field_of_work         text,
  has_projects          boolean,
  project_description   text,
  has_leadership        boolean,
  leadership_type       text,
  leadership_description text,
  team_style            text,
  community_problem     text,
  post_programme_goals  text,
  motivation            text,
  course_familiarity    text,
  can_commit_16w        boolean,
  hours_per_week        text,                  -- "1-3", "4-6", "7-10", "10+" — string not int because Forms gives ranges
  heard_about_us        text,
  consented             boolean NOT NULL DEFAULT false,
  -- A computed overall score, 0-25, summing the five prereq
  -- ratings. Useful for default sort in the review UI. Updated
  -- via trigger so we don't have to re-compute on every query.
  prereq_score          integer,
  -- The raw form row. Lets us recover from any column we forgot
  -- to map. Keys are the form's column headers verbatim.
  form_payload          jsonb,
  -- Review metadata
  reviewed_at           timestamptz,
  reviewed_by           text,                  -- email of organiser
  review_notes          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, cohort_id)              -- one application per person per cohort
);

CREATE TRIGGER applications_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Compute the prereq_score automatically on insert/update.
-- Doing this in SQL means application code can't accidentally
-- forget to recompute when a rating is edited.
CREATE OR REPLACE FUNCTION compute_prereq_score()
RETURNS TRIGGER AS $$
BEGIN
  NEW.prereq_score :=
    COALESCE(NEW.prereq_python, 0) +
    COALESCE(NEW.prereq_statistics, 0) +
    COALESCE(NEW.prereq_linear_alg, 0) +
    COALESCE(NEW.prereq_numpy_pandas, 0) +
    COALESCE(NEW.prereq_ml_concepts, 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_score
  BEFORE INSERT OR UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION compute_prereq_score();

CREATE INDEX IF NOT EXISTS idx_applications_cohort_status
  ON applications (cohort_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_person
  ON applications (person_id);
CREATE INDEX IF NOT EXISTS idx_applications_team_id_raw
  ON applications (cohort_id, team_id_raw);


-- ── enrolments ─────────────────────────────────────────────────
-- A person's relationship to a specific cohort once they've been
-- accepted (or assigned as a facilitator/mentor). Role is the
-- key field — same table holds students, facilitators, mentors,
-- and organisers, because the access pattern is the same: "who
-- is involved in this cohort?".
--
-- A person can have MULTIPLE enrolment rows for the same cohort
-- if their role changes mid-stream: a Cohort 9 student who comes
-- back as a Cohort 10 mentor has two rows, one per cohort. The
-- unique constraint is (person, cohort, role), allowing the
-- multi-role case (student + facilitator in same cohort) too.
CREATE TABLE IF NOT EXISTS enrolments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  cohort_id             uuid NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  -- The application this enrolment came from, if any. Facilitators
  -- and mentors don't always go through the application flow, so
  -- nullable.
  application_id        uuid REFERENCES applications(id) ON DELETE SET NULL,
  role                  text NOT NULL DEFAULT 'student'
                         CHECK (role IN ('student','facilitator','mentor','organiser')),
  status                text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','withdrawn','completed','removed')),
  -- joined_week / left_week: handles late joiners and early
  -- leavers. Attendance computations exclude weeks outside this
  -- range. Default to the cohort's full span.
  joined_week           integer NOT NULL DEFAULT 1,
  left_week             integer,
  -- Certificate eligibility, computed at cohort end. NULL while
  -- the cohort is running.
  certificate_eligible  boolean,
  certificate_issued_at timestamptz,
  -- Audit trail of when the row was created and by whom.
  accepted_at           timestamptz,
  accepted_by           text,                  -- organiser email
  withdrawn_at          timestamptz,
  withdrawal_reason     text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, cohort_id, role)
);

CREATE TRIGGER enrolments_updated_at
  BEFORE UPDATE ON enrolments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_enrolments_cohort_role
  ON enrolments (cohort_id, role);
CREATE INDEX IF NOT EXISTS idx_enrolments_person
  ON enrolments (person_id);
CREATE INDEX IF NOT EXISTS idx_enrolments_status
  ON enrolments (cohort_id, status) WHERE status = 'active';

-- Now that enrolments exists, add the FK from sessions.facilitator_id.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_facilitator_fk
  FOREIGN KEY (facilitator_id) REFERENCES enrolments(id) ON DELETE SET NULL;


-- ── teams ──────────────────────────────────────────────────────
-- Capstone or working teams within a cohort. The application form
-- has Team_ID which suggests pre-assignment at application time;
-- this table is where that lives.
CREATE TABLE IF NOT EXISTS teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id       uuid NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  -- The team ID as the form/spreadsheet used it. For Cohort 10
  -- this is a string like "T-01" or "Team Alpha". Stored as text
  -- because it's not a stable number across cohorts.
  display_id      text NOT NULL,
  name            text,
  -- Capstone project metadata. Optional; populated as teams
  -- decide on a project.
  project_title   text,
  project_brief   text,
  project_repo    text,
  project_demo    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, display_id)
);

CREATE TRIGGER teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── team_members ───────────────────────────────────────────────
-- Many-to-many between enrolments and teams. A team has multiple
-- students; in principle a student could be in multiple teams
-- (rare but the data model shouldn't preclude it).
CREATE TABLE IF NOT EXISTS team_members (
  team_id        uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  enrolment_id   uuid NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  role           text NOT NULL DEFAULT 'member'
                  CHECK (role IN ('member','lead')),
  joined_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, enrolment_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_enrolment
  ON team_members (enrolment_id);


INSERT INTO schema_migrations (filename)
VALUES ('003_applications_enrolments.sql')
ON CONFLICT (filename) DO NOTHING;
