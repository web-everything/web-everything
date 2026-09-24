---
bornAs: xzfv3va
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["3949"]
relatedTo: ["4029", "3690", "3673", "4035"]
scope: ["we:scripts/conveyor/log-delegation-trial.mjs", "we:scripts/conveyor/__tests__/log-delegation-trial.test.mjs", "we:scripts/lib/provider-routing.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Automated post-miss root-cause classifier: a distinct model attributes a confirmed miss to tooling or vendor

Build the classification step ratified rule 5 of #delegation-trial-record-graduation (decision #4029,
ratified 2026-09-24) requires: after a confirmed delegation-trial miss, a model DISTINCT from the delegated
builder triple classifies the miss as `rootCauseClass: 'tooling' | 'vendor'`, and a passive recurrence
detector tags a later repeat. No live effect until #3949 lands.

## Details

- **Classifier** — never the builder triple itself, never inferred from free text, never a required human
  (per #agent-convergence-independent-validation's distinct-fresh-validator doctrine). Reads the
  miss/diff/finding and writes `rootCauseClass` (`'tooling'|'vendor'`) plus, when tooling, a
  `rootCauseFixRef` (a PR or commit reference citing a concrete landed fix) onto the delegation-trial row —
  see we:scripts/conveyor/log-delegation-trial.mjs's existing `--root-cause` flag, which needs sibling
  `--root-cause-class`/`--root-cause-fix-ref`/`--root-cause-classified-by` flags. A missing or invalid class
  fails closed to `'vendor'`.
- **Recurrence detector** — a later confirmed miss for the same triple, classified by the same distinct
  classifier as the same failure class as an earlier tooling-fixed miss, is recorded as
  `recurrenceOfRootCause` (a reference to the earlier row) — never a proactive proof-trial gate.
- **Narrow human override** (mirroring #calibration-veto-clearing) — a human may correct a classification or
  a recurrence tag only on identity/evidentiary grounds (the cited fix does not exist or does not match the
  miss, the classifier misread the row) — never to re-litigate whether a landed fix is good enough.

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/log-delegation-trial.test.mjs` gets cases
   showing `--root-cause-class=tooling --root-cause-fix-ref="PR #1234" --root-cause-classified-by="claude:sonnet-5"`
   is accepted and written to the row's own fields, distinct from `--root-cause`'s free-text note; a
   `--root-cause-classified-by` equal to the builder triple is refused by name; and a missing/invalid class
   is written as `'vendor'` rather than left blank.
2. **Executable** — `npx vitest run we:scripts/lib/__tests__/provider-routing.test.mjs` gets a case showing
   a later confirmed miss classified as the same failure class as an earlier tooling-fixed miss for the same
   triple is recorded with `recurrenceOfRootCause` pointing at the earlier row.
