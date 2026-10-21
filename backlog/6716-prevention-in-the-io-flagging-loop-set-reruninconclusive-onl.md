---
bornAs: xe1lmc0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/conveyor/__tests__/main-ci-red-io.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — In the IO flagging loop, set rerunInconclusive only when classifyRun(run)==='ignore' for a comple… (from web-everything/web-everything#5271 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-ci-red-io.mjs:300` — In the IO flagging loop, set `rerunInconclusive` only when `classifyRun(run)==='ignore'` for a completed run (cancelled, skipped or infraOnly). Add a test that a failed or successful attempt-2 run plans no retry. A table-driven test over conclusions for the `again` branch would catch this class.
2. `we:scripts/conveyor/main-ci-red-io.mjs:59` — Add a check:standards lint that flags `gh api .../compare/` or list-returning `gh api` calls without --paginate, or require readChangedFiles to compare the file count to the reported total and return null when truncated.
3. `we:scripts/conveyor/main-ci-red-io.mjs:307` — Add a deterministic outcome-matrix test covering success, ordinary failure, cancellation, skipped, and infrastructure-only completion, asserting both rerun count and dispatch suppression.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5271@6628c9cd927788d20c99a7d772e5aec46ed26ad8

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
