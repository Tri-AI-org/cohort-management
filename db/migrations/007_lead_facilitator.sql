-- ============================================================
-- 007 - Lead facilitator permission
--
-- Adds is_lead to enrolments. A "lead facilitator" is still a
-- facilitator at the auth layer (session.kind = 'facilitator')
-- but with one extra capability: they can manage the facilitator
-- roster of their cohort (add/remove other facilitators, assign
-- them to sessions).
--
-- Implementation choice: a boolean on enrolments rather than a
-- new role value. Keeps the auth model simple (still student /
-- facilitator / organiser) and means a lead facilitator's
-- existing enrolment row is the same row — no role migration
-- needed if you "promote" them.
--
-- Lead facilitators CANNOT:
--   - See student personal data
--   - Review applications
--   - Edit cohort settings or the schedule structure
--   - Access /[n]/admin/dashboard or /students
-- They CAN:
--   - Visit /[n]/admin/facilitators
--   - Add/remove facilitators on their cohort
--   - Promote another facilitator to lead
-- ============================================================

ALTER TABLE enrolments
  ADD COLUMN IF NOT EXISTS is_lead boolean NOT NULL DEFAULT false;

-- Backfill: any existing facilitator who was created by an organiser
-- with no other peers stays a regular facilitator (is_lead=false).
-- Promote one manually with:
--   UPDATE enrolments SET is_lead = true
--    WHERE role='facilitator' AND cohort_id=(SELECT id FROM cohorts WHERE number=10)
--      AND person_id=(SELECT id FROM people WHERE email='lead@example.com');

INSERT INTO schema_migrations (filename)
VALUES ('007_lead_facilitator.sql')
ON CONFLICT (filename) DO NOTHING;
