---
bornAs: xun4mun
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/conveyor/health-smells/", "we:scripts/operations/completion-store.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# High alert when agent jobs fail fast: most review, fix or build jobs end blocked-on-infra within seconds

Live 2026-10-03 evening: after the org move every review job ended blocked-on-infra in 0.4-2 s ('the review loop printed no diff (it did not reach its read step)') and ~20 PRs sat at review:pending, re-dispatched in a loop. Health-watch only raised a medium pr-stage-stall after 20 min (symptom, not cause) and nothing acted. Add a health smell under we:scripts/conveyor/health-smells/ that reads the per-session blocked-on-infra streak already kept in we:scripts/operations/completion-store.mjs (#4227) plus review-job logs, and fires HIGH when, over a configurable window (default 15 min), most jobs of one kind (review, fix, ci-heal, build) end blocked-on-infra or before their first step. High means: WIP page high alert plus a phone push, and an entry the health responder (epic 4795) can act on. Also: health smells must use the new repo slugs (they still print chalbert/...). Done when: tests fire the smell on a seeded failing-fast window and stay quiet on normal traffic; a soak break replays tonight's review outage; the live smell names the job kind, count and last error.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
