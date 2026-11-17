---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/lib/review-red-team-on-skip.mjs"]
dateOpened: "2026-11-17"
tags: []
---

# Resume a record step held on pending CI so the red team can dispatch

A review run stopped at step record when its label-swap failed with "review held: CI still pending on reviewed head" is never resumed, so review-unfinished escalates every tick and the red team never dispatches (#6940). Such a run is now resumable, bounded by the ciHeldRecordRetryMax setting (default 3, 0 = off); the resumed record step re-checks CI itself, so a verdict is never recorded while CI is pending.

## Acceptance

- [A1] **Executable** — the scoped vitest run of we:scripts/conveyor/__tests__/review-referral-hold.test.mjs and we:scripts/lib/__tests__/review-red-team-on-skip.test.mjs passes, and the new soak break ci-held-record-effect-never-resumes fails before this change and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the pre-write retryableRecordEffect rule and never records a verdict while CI is pending.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the error string is matched against a fixed pattern only.
2. **Truncated reads** — n/a: unreadable effects keep the human hold.
3. **Shared state files** — n/a: reads run evidence only, writes nothing.
4. **Fail closed** — over the bound or any other failure still escalates review-unfinished; 0 turns it off.
5. **Identity scoping** — resume is keyed to the run id on the same head.
6. **State over time** — an operator comment after the run began blocks the resume; a retry cooldown applies.
7. **Who wrote it** — n/a: operator comments are handled by the existing operatorWakeTime check.
