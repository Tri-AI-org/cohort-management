-- ============================================================
-- 006 - Cohort config extensions
--
-- Adds the columns we need for cohorts to be fully editable from
-- the admin UI without touching markdown:
--
--   - cohorts.summary, cohorts.format, cohorts.duration — narrative
--     metadata previously only in markdown frontmatter.
--   - cohorts.discord_url, cohorts.mailing_list_url,
--     cohorts.skills_boost_url, cohorts.main_site_url —
--     external destinations previously in markdown links: section.
--   - cohorts.reminder_cron_dow, .reminder_cron_hour_utc —
--     when Saturday reminders go out for THIS cohort. Defaults
--     to Saturday 06:00 UTC, but cohort 11 might run on a
--     different day in a different timezone.
--   - cohorts.email_from_name, .email_reply_to — per-cohort
--     overrides for emails. Falls back to env vars if NULL.
--   - cohorts.session_day_of_week — informational; lets us validate
--     scheduled dates fall on the expected day.
--   - cohorts.portal_flags — jsonb bag for the portal.* feature
--     flags previously in markdown. Editable per cohort.
--
-- All columns are nullable / have defaults so this migration
-- doesn't break existing cohort 10 data.
-- ============================================================

-- Narrative
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS summary           text;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS format            text;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS duration_label    text;     -- e.g. "16 weeks", "12 weeks"
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS year              integer;

-- External links
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS discord_url       text;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS mailing_list_url  text;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS skills_boost_url  text;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS main_site_url     text;

-- Reminder cron schedule. Default to Saturday 06:00 UTC = 07:00 Lagos.
-- Cron day-of-week: 0=Sun, 1=Mon, ..., 6=Sat
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS reminder_cron_dow      integer NOT NULL DEFAULT 6
                       CHECK (reminder_cron_dow BETWEEN 0 AND 6);
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS reminder_cron_hour_utc integer NOT NULL DEFAULT 6
                       CHECK (reminder_cron_hour_utc BETWEEN 0 AND 23);
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS atrisk_cron_dow        integer NOT NULL DEFAULT 3
                       CHECK (atrisk_cron_dow BETWEEN 0 AND 6);
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS atrisk_cron_hour_utc   integer NOT NULL DEFAULT 9
                       CHECK (atrisk_cron_hour_utc BETWEEN 0 AND 23);

-- Per-cohort email overrides (fall back to env vars if NULL)
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS email_from_name   text;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS email_reply_to    text;

-- Session day of week (informational; defaults to Saturday)
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS session_day_of_week integer NOT NULL DEFAULT 6
                       CHECK (session_day_of_week BETWEEN 0 AND 6);

-- Portal feature flags as jsonb. Replaces the markdown portal: block.
-- Defaults match what cohort 10's markdown says now.
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS portal_flags jsonb NOT NULL DEFAULT
  '{"enabled": true, "attendanceOpen": true, "facilitatorOpen": true, "dashboardOpen": true, "onboardingOpen": false, "myStatusOpen": true}'::jsonb;


-- Backfill cohort 10 from the values we know:
UPDATE cohorts SET
  year             = COALESCE(year, 2026),
  summary          = COALESCE(summary, 'A milestone tenth cohort, delivered in partnership with Google DeepMind. Sixteen weeks taking learners from language model fundamentals to building their own Small Language Model.'),
  format           = COALESCE(format, 'Hybrid'),
  duration_label   = COALESCE(duration_label, '16 weeks'),
  discord_url      = COALESCE(discord_url,      'https://discord.gg/8sA4Tkgpkt'),
  mailing_list_url = COALESCE(mailing_list_url, 'https://groups.google.com/a/tri-ai.org/g/cohort-10'),
  skills_boost_url = COALESCE(skills_boost_url, 'https://www.skills.google/users/sign_up'),
  main_site_url    = COALESCE(main_site_url,    'https://tri-ai.org/programmes/tri-ai-saturdays/cohorts/10')
WHERE number = 10;


-- A view to fetch everything the portal needs in one query, including
-- the session list. Pages can SELECT * from this rather than joining
-- three tables every time.
CREATE OR REPLACE VIEW cohort_full AS
SELECT
  c.*,
  (SELECT json_agg(row_to_json(s.*) ORDER BY s.week_number)
     FROM sessions s WHERE s.cohort_id = c.id) AS sessions_json
FROM cohorts c;


INSERT INTO schema_migrations (filename)
VALUES ('006_cohort_config.sql')
ON CONFLICT (filename) DO NOTHING;
