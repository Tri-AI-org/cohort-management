-- ============================================================
-- 005 - Views for dashboard and student-facing queries
--
-- These views encode the rules ("how do we compute at-risk?",
-- "what counts toward certificate eligibility?") in ONE place,
-- in SQL. Application code SELECTs from them; it does not
-- re-derive these computations.
--
-- The benefit: change the at-risk rule from "3 misses" to "missed
-- 2 of last 4" and only this file changes. No grep across
-- function code.
-- ============================================================

-- ── student_attendance_summary ────────────────────────────────
-- The headline numbers for any given enrolment:
--   - how many sessions are countable for them (excluding break,
--     joined_week filter, left_week filter)
--   - how many they've attended (live or recording)
--   - how many they've missed (only sessions that have already
--     happened)
--   - attendance pct
--   - certificate eligibility (TRUE if attendance_pct >= cohort's
--     threshold AND cohort is completed)
--   - risk status (ok | warning | critical) based on misses so
--     far this cohort
--
-- This view is the source of truth for everything the student
-- sees on their /me page and everything organisers see in the
-- at-risk panel.
--
-- Performance note: this is a regular view, recomputed on each
-- query. For Cohort 10's ~3000 students this is fast (well under
-- 100ms) on indexed Postgres. If you ever scale to 100k students
-- across 50 cohorts and this becomes slow, convert to a
-- materialised view refreshed nightly. Don't pre-optimise.
CREATE OR REPLACE VIEW student_attendance_summary AS
SELECT
  e.id                   AS enrolment_id,
  e.person_id,
  e.cohort_id,
  c.number               AS cohort_number,
  c.cert_attendance_pct,
  c.atrisk_warn_misses,
  c.atrisk_crit_misses,
  -- Sessions that count for this enrolment: in the cohort, not
  -- the break week, within the joined/left range. Note we count
  -- ALL countable sessions, not just past ones, so the "% to go"
  -- is correct.
  COUNT(s.id) FILTER (
    WHERE s.is_break = false
  )                      AS countable_sessions,
  -- Sessions in the past — the denominator for current-state
  -- attendance percentage.
  COUNT(s.id) FILTER (
    WHERE s.is_break = false AND s.session_date < CURRENT_DATE
  )                      AS elapsed_sessions,
  -- Attended count: anything not 'missed' and not 'excused' is
  -- considered attended. 'recording' counts; 'excused' doesn't
  -- count for or against.
  COUNT(a.id) FILTER (
    WHERE a.status IN ('live','recording')
  )                      AS attended_count,
  COUNT(a.id) FILTER (
    WHERE a.status = 'missed' AND s.session_date < CURRENT_DATE
  )                      AS missed_count,
  COUNT(a.id) FILTER (
    WHERE a.status = 'excused'
  )                      AS excused_count,
  -- Attendance percentage so far. NULL when no elapsed sessions
  -- yet (avoids division-by-zero and shows blank in the UI).
  CASE
    WHEN COUNT(s.id) FILTER (
      WHERE s.is_break = false AND s.session_date < CURRENT_DATE
    ) = 0 THEN NULL
    ELSE ROUND(
      100.0 * COUNT(a.id) FILTER (WHERE a.status IN ('live','recording'))
      / NULLIF(COUNT(s.id) FILTER (
        WHERE s.is_break = false AND s.session_date < CURRENT_DATE
        AND a.status IS DISTINCT FROM 'excused'
      ), 0)
    )
  END                    AS attendance_pct,
  -- Risk classification, computed from missed_count vs the
  -- cohort's thresholds.
  CASE
    WHEN COUNT(a.id) FILTER (
      WHERE a.status = 'missed' AND s.session_date < CURRENT_DATE
    ) >= c.atrisk_crit_misses THEN 'critical'
    WHEN COUNT(a.id) FILTER (
      WHERE a.status = 'missed' AND s.session_date < CURRENT_DATE
    ) >= c.atrisk_warn_misses THEN 'warning'
    ELSE 'ok'
  END                    AS risk_status
FROM enrolments e
JOIN cohorts c ON c.id = e.cohort_id
LEFT JOIN sessions s
  ON s.cohort_id = e.cohort_id
  AND s.week_number BETWEEN e.joined_week AND COALESCE(e.left_week, 999)
LEFT JOIN attendance a
  ON a.enrolment_id = e.id AND a.session_id = s.id
WHERE e.role = 'student' AND e.status = 'active'
GROUP BY e.id, e.person_id, e.cohort_id, c.number,
         c.cert_attendance_pct, c.atrisk_warn_misses, c.atrisk_crit_misses;


-- ── cohort_overview ───────────────────────────────────────────
-- The top-of-dashboard summary: how many students, what's the
-- average attendance, how many at-risk. The current dashboard
-- shows these four numbers and updates them per refresh.
CREATE OR REPLACE VIEW cohort_overview AS
SELECT
  c.id                                           AS cohort_id,
  c.number                                       AS cohort_number,
  c.status,
  COUNT(DISTINCT e.id) FILTER (WHERE e.role = 'student' AND e.status = 'active') AS active_students,
  COUNT(DISTINCT e.id) FILTER (WHERE e.role = 'student' AND e.status = 'withdrawn') AS withdrawn_students,
  COUNT(DISTINCT e.id) FILTER (WHERE e.role = 'facilitator') AS facilitator_count,
  (SELECT ROUND(AVG(attendance_pct))
     FROM student_attendance_summary
     WHERE cohort_id = c.id AND attendance_pct IS NOT NULL) AS avg_attendance_pct,
  (SELECT COUNT(*)
     FROM student_attendance_summary
     WHERE cohort_id = c.id AND risk_status = 'critical')  AS critical_count,
  (SELECT COUNT(*)
     FROM student_attendance_summary
     WHERE cohort_id = c.id AND risk_status = 'warning')   AS warning_count
FROM cohorts c
LEFT JOIN enrolments e ON e.cohort_id = c.id
GROUP BY c.id, c.number, c.status;


-- ── session_drop_off ──────────────────────────────────────────
-- The bar-chart data for the dashboard: for each session, how
-- many students attended (live or recording), how many missed,
-- and the attendance rate. This is the one chart that drives the
-- "where do students fall off?" intuition.
CREATE OR REPLACE VIEW session_drop_off AS
SELECT
  s.id                                          AS session_id,
  s.cohort_id,
  s.week_number,
  s.session_date,
  s.topic,
  s.is_break,
  COUNT(a.id) FILTER (WHERE a.status = 'live')      AS attended_live,
  COUNT(a.id) FILTER (WHERE a.status = 'recording') AS watched_recording,
  COUNT(a.id) FILTER (WHERE a.status = 'missed')    AS missed,
  COUNT(a.id) FILTER (WHERE a.status = 'excused')   AS excused,
  -- Students who could have attended (enrolled by this week,
  -- not yet left, active status). Denominator for the rate.
  (SELECT COUNT(*)
     FROM enrolments e
     WHERE e.cohort_id = s.cohort_id
       AND e.role = 'student' AND e.status = 'active'
       AND s.week_number BETWEEN e.joined_week AND COALESCE(e.left_week, 999)
  )                                                   AS eligible_students
FROM sessions s
LEFT JOIN attendance a ON a.session_id = s.id
GROUP BY s.id, s.cohort_id, s.week_number, s.session_date, s.topic, s.is_break;


INSERT INTO schema_migrations (filename)
VALUES ('005_views.sql')
ON CONFLICT (filename) DO NOTHING;
