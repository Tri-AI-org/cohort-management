/**
 * Astro content collections for the cohort portal.
 *
 * The cohorts collection is structurally a subset of the main site's
 * cohorts collection (tri-ai.org/src/content.config.ts), but trimmed
 * to the fields the portal actually needs:
 *
 *   - The portal doesn't display instructors, mentors, capstones, or
 *     projectsUrl; those live on the public cohort detail page on
 *     tri-ai.org.
 *   - The portal DOES need schedule, breakWeek, portal flags, targets,
 *     and links — none of which the marketing site uses.
 *
 * Cohort markdown files are duplicated from the main site for now (per
 * decision: simpler than a submodule or API; cohort schedules don't
 * change once published, so drift risk is low). Revisit if drift
 * becomes painful.
 */

import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const cohortSession = z.object({
  week:    z.number(),
  date:    z.string(),        // e.g. "June 7, 2026" — Date parsing
                              // happens at render time, see src/lib/cohort.ts
  topic:   z.string(),
  isBreak: z.boolean().optional(),
  // Optional links — populated by facilitator submissions or filled
  // in manually as the cohort runs. The schedule page renders them
  // as they become available.
  slidesUrl:    z.string().url().optional(),
  notebookUrl:  z.string().url().optional(),
  recordingUrl: z.string().url().optional(),
  readingsUrl:  z.string().url().optional(),
});

const cohorts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/cohorts' }),
  schema: z.object({
    // ─── Identity ───
    number:   z.number(),                          // the URL parameter
    year:     z.number(),
    title:    z.string().optional(),
    partner:  z.string().optional(),
    summary:  z.string(),
    status:   z.enum(['upcoming', 'running', 'completed']).default('upcoming'),

    // ─── Dates ───
    startDate: z.string().optional(),
    endDate:   z.string().optional(),
    duration:  z.string().optional(),
    format:    z.string().optional(),

    // ─── Week-by-week ───
    schedule:  z.array(cohortSession).optional(),
    breakWeek: z.number().optional(),

    // ─── Surface flags ───
    // Default all-off. The cohort organiser flips these as each surface
    // is ready. A new cohort can exist with portal: { enabled: true }
    // and everything else false — the landing page renders with only
    // the surfaces that are open.
    portal: z.object({
      enabled:          z.boolean().default(false),
      attendanceOpen:   z.boolean().default(false),
      facilitatorOpen:  z.boolean().default(false),
      dashboardOpen:    z.boolean().default(false),
      onboardingOpen:   z.boolean().default(false),
      myStatusOpen:     z.boolean().default(false),
    }).optional().default({}),

    // ─── Thresholds ───
    targets: z.object({
      certificateAttendancePct: z.number().min(0).max(100).default(60),
      atRiskAbsencesWarning:    z.number().default(2),
      atRiskAbsencesCritical:   z.number().default(3),
    }).optional().default({}),

    // ─── External links ───
    links: z.object({
      discord:     z.string().url().optional(),
      mailingList: z.string().url().optional(),
      skillsBoost: z.string().url().optional(),
      youtube:     z.string().url().optional(),
      mainSiteUrl: z.string().url().optional(), // pointer back to the
                                                 // public cohort page on
                                                 // tri-ai.org for context
    }).optional().default({}),
  }),
});

export const collections = { cohorts };
