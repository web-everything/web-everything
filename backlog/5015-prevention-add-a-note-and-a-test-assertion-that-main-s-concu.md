---
bornAs: x3otd6p
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/__tests__/ci-main-runs-not-cancelled.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a note and a test assertion that main's concurrency group is unique per run, or verify the live pro… (from chalbert/web-everything#3839 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:52` — Add a note and a test assertion that main's concurrency group is unique per run, or verify the live proof (card item 3) on a real merge burst before calling the slice done. A check:standards rule is not practical here because the behaviour is GitHub runtime semantics.
2. `we:.github/workflows/ci.yml:54` — Add a deterministic workflow-policy gate requiring main runs to have independent concurrency groups if every pushed revision must execute, with a regression case covering three overlapping main pushes.
3. `we:scripts/__tests__/ci-main-runs-not-cancelled.test.mjs:22` — Parse the workflow and assert the complete supported cancellation expression and group value, or evaluate the expression for main and PR refs; include always-true and always-false regression fixtures.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3839@d02bd3705ba238769b31cf8c10055d515191f898

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
