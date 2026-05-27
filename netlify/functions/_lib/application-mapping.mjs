/**
 * _lib/application-mapping.mjs
 *
 * The Google Form's column headers → applications table columns.
 *
 * When the form changes between cohorts (and it will — you'll add
 * a question, reword another), update this file. The raw row is
 * always stored in form_payload, so even unmapped columns aren't
 * lost.
 *
 * Each mapping entry has:
 *   header      — the exact column header in the Google Form CSV
 *                 (case-sensitive; whitespace matters; trailing
 *                 spaces are tolerated by the matcher below)
 *   column      — the applications table column to write to
 *   transform   — optional function to coerce the raw string to
 *                 the target type
 *
 * Multiple headers can map to the same column for forwards-compat:
 * if Cohort 11 renames "Email address" to "Email", list both.
 */

// ── Transforms ─────────────────────────────────────────────────

const yesNo = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true')  return true;
  if (s === 'no'  || s === 'n' || s === 'false') return false;
  return null;
};

/**
 * Many Google Form rating questions give answers like "3 - Comfortable"
 * or just "3". Extract the leading integer.
 */
const ratingFromAnswer = (v) => {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^([1-5])/);
  return m ? parseInt(m[1], 10) : null;
};

const trimOrNull = (v) => {
  const s = String(v || '').trim();
  return s.length > 0 ? s : null;
};

// ── The mapping table ──────────────────────────────────────────

export const APPLICATION_MAPPING = [
  // Identity (these go to people, not applications)
  { header: 'Email address',                                          column: '__email__',           transform: trimOrNull, role: 'identity' },
  { header: 'First name',                                             column: '__first_name__',      transform: trimOrNull, role: 'identity' },
  { header: 'Last name',                                              column: '__last_name__',       transform: trimOrNull, role: 'identity' },
  { header: 'What Country are you located?',                          column: '__country__',         transform: trimOrNull, role: 'identity' },
  { header: 'Which City/State are you located?',                      column: '__city__',            transform: trimOrNull, role: 'identity' },
  { header: 'Gender',                                                 column: '__gender__',          transform: trimOrNull, role: 'identity' },
  { header: 'Age Range',                                              column: '__age_range__',       transform: trimOrNull, role: 'identity' },
  { header: 'Please provide a link to your GitHub profile.',          column: '__github_url__',      transform: trimOrNull, role: 'identity' },

  // Application metadata
  { header: 'Team_ID',                                                column: 'team_id_raw',         transform: trimOrNull },
  { header: 'Have you previously participated in TRI AI Saturdays (AI Saturdays Lagos) cohorts?',
                                                                      column: 'previous_participant', transform: yesNo },

  // Prerequisite ratings — the long header variants and short alternatives
  { header: 'How would you rate your experience with these prerequisite topics? [Python]',
                                                                      column: 'prereq_python',       transform: ratingFromAnswer },
  { header: 'How would you rate your experience with these prerequisite topics? [Statistics (Basic)]',
                                                                      column: 'prereq_statistics',   transform: ratingFromAnswer },
  { header: 'How would you rate your experience with these prerequisite topics? [Linear Algebra]',
                                                                      column: 'prereq_linear_alg',   transform: ratingFromAnswer },
  { header: 'How would you rate your experience with these prerequisite topics? [Numpy/Pandas]',
                                                                      column: 'prereq_numpy_pandas', transform: ratingFromAnswer },
  { header: 'How would you rate your experience with these prerequisite topics? [Basic Machine Learning Concepts (training, overfitting, underfitting, neural networks)]',
                                                                      column: 'prereq_ml_concepts',  transform: ratingFromAnswer },

  // Work
  { header: 'Current Role / Background',                              column: 'applicant_role',        transform: trimOrNull },
  { header: 'If you are working, what is your current job title?',    column: 'job_title',           transform: trimOrNull },
  { header: 'What is your current field of Work?',                    column: 'field_of_work',       transform: trimOrNull },

  // Projects
  { header: 'Have you worked on any programming or data-related projects?',
                                                                      column: 'has_projects',        transform: yesNo },
  { header: '  If yes, briefly describe one project. ',               column: 'project_description', transform: trimOrNull },

  // Leadership
  { header: 'Have you ever had any leadership experience before?',    column: 'has_leadership',      transform: yesNo },
  { header: 'If yes, what type of leadership was it?',                column: 'leadership_type',     transform: trimOrNull },
  { header: 'Please, briefly describe your leadership experience.',   column: 'leadership_description', transform: trimOrNull },
  { header: "When working in a team, what's your preferred style?",   column: 'team_style',          transform: trimOrNull },

  // Motivation
  { header: 'Tell us a problem in your community that you think can be solved using machine learning model',
                                                                      column: 'community_problem',   transform: trimOrNull },
  { header: 'What are your goals after completing this programme?',   column: 'post_programme_goals', transform: trimOrNull },
  { header: 'What is your motivation for joining TRI AI Saturdays Cohort 10?',
                                                                      column: 'motivation',          transform: trimOrNull },

  // Familiarity / commitment
  { header: 'The cohort goes through the Google DeepMind AI Research Foundations course 1-4 on Google cloud skill boost. Are you familiar with the courses?',
                                                                      column: 'course_familiarity',  transform: trimOrNull },
  { header: 'The cohort runs for 16 weeks. Can you commit to this schedule?',
                                                                      column: 'can_commit_16w',      transform: yesNo },
  { header: 'How many hours per week can you realistically commit?',  column: 'hours_per_week',      transform: trimOrNull },

  // Attribution
  { header: 'How did you hear about us?',                             column: 'heard_about_us',      transform: trimOrNull },
];

// Headers that, if present, indicate consent. Multiple variants to
// future-proof against form rewording.
const CONSENT_HEADERS = [
  'By submitting this form, you agree that your personal data will be collected and processed by Artificial Intelligence, Teaching, Research and Innovation (TRI AI) for the purpose of',
];

const TIMESTAMP_HEADERS = ['Timestamp', 'Submission Time', 'Submitted'];


/**
 * Normalise a CSV header for fuzzy matching: trim, collapse whitespace,
 * remove trailing question-mark variations.
 */
function normHeader(h) {
  return String(h || '').replace(/\s+/g, ' ').trim();
}

/**
 * Translate one CSV row (object with header → value) into:
 *   { person: {...identity fields}, application: {...form fields}, payload: rawRow }
 */
export function mapRow(rawRow) {
  const person = {};
  const application = { form_payload: rawRow };
  let consented = false;
  let submittedAt = null;

  // Build header → mapping lookup. Normalised headers so we don't
  // care about trailing whitespace in the CSV.
  const normalisedRow = {};
  for (const [k, v] of Object.entries(rawRow)) {
    normalisedRow[normHeader(k)] = v;
  }

  for (const m of APPLICATION_MAPPING) {
    const key = normHeader(m.header);
    if (!(key in normalisedRow)) continue;
    const raw = normalisedRow[key];
    const value = m.transform ? m.transform(raw) : raw;

    if (m.role === 'identity') {
      const field = m.column.replace(/^__|__$/g, '');     // __email__ → email
      person[field] = value;
    } else {
      application[m.column] = value;
    }
  }

  // Consent: any header that STARTS WITH one of the consent prefixes
  // and has a truthy value counts as consented.
  for (const [k, v] of Object.entries(normalisedRow)) {
    for (const prefix of CONSENT_HEADERS) {
      if (k.startsWith(prefix) && String(v).trim().length > 0) {
        consented = true;
        break;
      }
    }
  }
  application.consented = consented;

  // Submission timestamp from any of the known timestamp columns.
  for (const h of TIMESTAMP_HEADERS) {
    if (normalisedRow[h]) {
      const d = new Date(normalisedRow[h]);
      if (!isNaN(d)) submittedAt = d;
      break;
    }
  }
  if (submittedAt) application.submitted_at = submittedAt;

  return { person, application };
}
