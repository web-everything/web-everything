---
kind: story
size: 2
status: open
dateOpened: "2026-11-12"
tags: []
related: ["6668"]
---

# Hung-ci completed-run rerun: read run conclusion and check marker provenance (reinforce R903)

Reinforce the hung-ci completed-run handling (R895+R903 residuals). (1) Before cancelAndRerunHungRun re-runs failed jobs after a completed-run 409, read the run's final conclusion and failure attribution, so a genuine failure that finished after candidate selection stays with ci-red/ci-heal. (2) Provenance check for both markers: the run-not-found-retrigger and run-already-completed checks in sweepHungCiRecovery trust any commenter body; require the trusted-author leading marker (countTrustedLeadingMarker) before treating either as a recorded outcome.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs`: after a completed-run 409 the run conclusion is read and only `cancelled`/`timed_out` runs are re-run (failure/success hand off, unreadable fails closed); a handled marker from an untrusted commenter does not suppress recovery.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the retry cap, the cancel-only escalation, or ci-red/ci-heal; only gates the post-409 rerun and the handled-marker read.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the conclusion is matched against fixed sets, never interpolated; marker bodies are data.
2. **Truncated reads** — n/a: the conclusion read is a single `--jq` scalar; comments come from the complete-thread reader.
3. **Shared state files** — n/a: no state file; state is PR comments.
4. **Fail closed** — an unreadable or unknown conclusion returns `conclusion-unreadable` (a counted attempt) with no rerun write.
5. **Identity scoping** — the handled marker must match run and head sha exactly.
6. **State over time** — a run that finished with a genuine failure after selection is left to ci-red/ci-heal.
7. **Who wrote it** — the handled marker needs the trusted-author leading marker (`countTrustedLeadingMarker`).

## Duplicate admission

residuals of the cancel-409-completed fix

new guards for races the fix accepts
