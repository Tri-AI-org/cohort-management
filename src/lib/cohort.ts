/**
 * Cohort helper functions.
 *
 * Anything that touches the cohort schedule and asks "what week are we
 * in?" or "is the check-in window open?" lives here, so the answer is
 * the same across the portal landing, check-in, and schedule pages.
 *
 * These run at build time. Astro re-renders these pages every time the
 * site rebuilds, so:
 *
 *   - If you set up Netlify's scheduled rebuild (recommended — see
 *     docs/DEPLOY.md), the "current week" updates automatically every
 *     Saturday morning when the next session opens.
 *   - If you don't, "current week" is whatever was true at the last
 *     deploy. For a 16-week cohort that's at most 7 days of staleness,
 *     which is mildly annoying but not broken — students would still
 *     see the right week most of the time.
 */

import type { z } from 'astro:content';

// Reflects the schema in src/content.config.ts. Kept as a structural
// type rather than re-importing the Zod schema to avoid a circular
// dependency at type-resolution time.
export interface CohortSession {
  week: number;
  date: string;
  topic: string;
  isBreak?: boolean;
  slidesUrl?: string;
  notebookUrl?: string;
  recordingUrl?: string;
  readingsUrl?: string;
}

/**
 * Parse a frontmatter date string. We deliberately accept JS's native
 * `new Date("June 7, 2026")` parsing here because (a) it works on the
 * formats we control, and (b) it avoids pulling in a date library for
 * one operation.
 */
function parseSessionDate(s: string): Date {
  return new Date(s);
}

/**
 * The check-in window for week N opens Saturday morning and closes
 * the following Friday at end-of-day. That's six days after the
 * session date. Used by both the portal landing's "this week" banner
 * and the check-in page's "should we render the form?" check.
 */
export function isCheckInWindowOpen(session: CohortSession, now: Date = new Date()): boolean {
  if (session.isBreak) return false;
  const start = parseSessionDate(session.date);
  const close = new Date(start);
  close.setDate(close.getDate() + 6);
  // Open from start-of-day Saturday through end-of-day Friday
  start.setHours(0, 0, 0, 0);
  close.setHours(23, 59, 59, 999);
  return now >= start && now <= close;
}

export interface CohortState {
  /** The session whose check-in window is open, OR the next session
   *  if none is open right now. Null if the cohort hasn't started or
   *  has finished. */
  currentSession: CohortSession | null;
  /** True before the first session date. */
  preStart: boolean;
  /** True after the last session's window has closed. */
  completed: boolean;
  /** True if the current week is the break week. */
  onBreak: boolean;
}

export function getCohortState(
  schedule: CohortSession[] | undefined,
  now: Date = new Date()
): CohortState {
  const empty: CohortState = {
    currentSession: null,
    preStart: false,
    completed: false,
    onBreak: false,
  };
  if (!schedule || schedule.length === 0) return empty;

  const first = parseSessionDate(schedule[0].date);
  first.setHours(0, 0, 0, 0);
  if (now < first) {
    return { ...empty, currentSession: schedule[0], preStart: true };
  }

  // Find the first session whose closing date is today-or-later.
  // That's either the open window now, or the next one to open.
  const upcoming = schedule.find(s => {
    const close = parseSessionDate(s.date);
    close.setDate(close.getDate() + 6);
    close.setHours(23, 59, 59, 999);
    return now <= close;
  });

  if (!upcoming) {
    return { ...empty, currentSession: schedule[schedule.length - 1], completed: true };
  }

  return {
    currentSession: upcoming,
    preStart: false,
    completed: false,
    onBreak: !!upcoming.isBreak,
  };
}
