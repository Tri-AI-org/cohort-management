---
number: 10
year: 2026
title: Cohort 10 — AI Research Foundations w/ Google DeepMind
partner: Google DeepMind
status: running

summary: A milestone tenth cohort, delivered in partnership with Google
  DeepMind. Sixteen weeks taking learners from language model fundamentals
  to building their own Small Language Model.

startDate: May 31, 2026
endDate: September 19, 2026
duration: 16 weeks
format: Hybrid

# ─── Portal surfaces — flip each one on as it's ready ───
portal:
  enabled: true
  attendanceOpen: true
  facilitatorOpen: true
  dashboardOpen: true
  onboardingOpen: true
  myStatusOpen: false   # Phase 2 feature — backend isn't ready yet

# ─── Attendance + certificate rules ───
targets:
  certificateAttendancePct: 60
  atRiskAbsencesWarning: 2
  atRiskAbsencesCritical: 3

# ─── External destinations ───
links:
  discord: https://discord.gg/8sA4Tkgpkt
  mailingList: https://groups.google.com/a/tri-ai.org/g/cohort-10
  skillsBoost: https://www.skills.google/users/sign_up
  mainSiteUrl: https://tri-ai.org/programmes/tri-ai-saturdays/cohorts/10

# ─── Week-by-week schedule ───
breakWeek: 7

schedule:
  - { week: 1,  date: "June 7, 2026",       topic: "Introduction to Language Modeling" }
  - { week: 2,  date: "June 14, 2026",      topic: "From N-grams to Transformers" }
  - { week: 3,  date: "June 21, 2026",      topic: "Training a Language Model" }
  - { week: 4,  date: "June 28, 2026",      topic: "Text & Data Preprocessing" }
  - { week: 5,  date: "July 5, 2026",       topic: "Tokenization" }
  - { week: 6,  date: "July 12, 2026",      topic: "Embeddings" }
  - { week: 7,  date: "July 19, 2026",      topic: "Mid-Cohort Break", isBreak: true }
  - { week: 8,  date: "July 26, 2026",      topic: "Introduction to Neural Networks" }
  - { week: 9,  date: "August 2, 2026",     topic: "Modeling Complex Data with MLP" }
  - { week: 10, date: "August 9, 2026",     topic: "Gradients & Backpropagation" }
  - { week: 11, date: "August 16, 2026",    topic: "Architecture of Modern LLMs" }
  - { week: 12, date: "August 23, 2026",    topic: "The Attention Mechanism" }
  - { week: 13, date: "August 30, 2026",    topic: "Positional Embeddings" }
  - { week: 14, date: "September 6, 2026",  topic: "Project Week" }
  - { week: 15, date: "September 13, 2026", topic: "Transformer Block & Layer Normalization" }
  - { week: 16, date: "September 19, 2026", topic: "Demo Day" }
---

The portal markdown body is **intentionally empty** for now. The public
narrative about this cohort (curriculum overview, why this cohort matters,
acknowledgements) lives on tri-ai.org at the URL in `links.mainSiteUrl`.

If you want to add portal-only context — internal announcements, a welcome
note to participants, links that change mid-cohort — this body is where
it goes. It renders on the portal landing page under the surface grid.
