---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/conveyor/main-ci-red-core.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5271 (head 6628c9cd9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5271 (reviewed head `6628c9cd927788d20c99a7d772e5aec46ed26ad8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/main-ci-red-io.mjs:190` — (failing-input, degraded) A third failed job is excluded from flake evidence
   - Scenario: Provide a first-attempt failed run with three non-summary failed jobs: the first two contain matching timeout failures; the third contains an AssertionError. Disable mainCiRedRerunUnrelatedChange to isolate the signature rule. The probe reads only the first two logs, returns eligible:true with reason flaky-signature, and plans a rerun despite the deterministic failure. A read-only Node probe reproduced this. Eligibility should require evidence covering every failed job; an unread third job should prevent signature-based qualification.
   - Claude's re-check: The probe reads logs for only the first two non-summary failed jobs ('.slice(0,2)'). 'classifyFlakeRun' ignores 'failedJobs', so if those two match the timeout signature it returns flaky-signature without seeing a third job's AssertionError.
2. `we:scripts/conveyor/main-ci-red-core.mjs:163` — (failing-input, degraded) Suite-load failures disappear from the all-failures check
   - Scenario: Give one failed job this log: 'FAIL we:a.test.mjs &gt; timeout\nError: Test timed out in 180000ms.\nFAIL we:b.test.mjs [ we:b.test.mjs ]\nSyntaxError: Unexpected token'. parseVitestFailures returns only the timeout because the suite-load header lacks ' &gt; '. With unrelated-change reruns disabled, classifyFlakeRun still returns eligible:true. The deterministic syntax failure should prevent the run from qualifying as entirely flaky. This was reproduced with the checked-out function bodies.
   - Claude's re-check: 'parseVitestFailures' only matches 'FAIL file &gt; title'. A suite-load header like 'FAIL we:b.test.mjs [ we:b.test.mjs ]' is skipped, so only the timeout is parsed and 'failures.every(...)' passes, making the run eligible.
3. `we:scripts/conveyor/main-ci-red-io.mjs:343` — (edge-case, degraded) An issued rerun loses owner suppression before its new attempt appears
   - Scenario: Tick 1 successfully requests a flake rerun for run 2 and records status issued. Tick 2 receives the same completed attempt-1 failure snapshot before GitHub exposes the queued rerun. The ledger prevents another request, but rerunPending becomes false because issued is local to the current tick and the snapshot is completed. With the threshold elapsed and no owner, tick 2 dispatches a repair session while the rerun is outstanding. An in-memory I/O probe reproduced decision.reason='owed' and a dispatch on tick 2. Requested/issued reservations should suppress ownership until a newer attempt is obs
   - Claude's re-check: 'issued' is local to the tick. On tick 2 the ledgered run 2 is still a completed attempt-1 failure, so it gets no 'rerunPending' flag and 'planMainCiRerun' returns null because the run is already in the ledger. 'rerunPending' is then false and 'decideOwner' can dispatch while the rerun is outstanding. The window is narrow, but the code allows it.

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
