---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-job-end-diagnosis.mjs", "we:skills-src/conveyor/__tests__/review-daemon-juror-timeout.test.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:scripts/operations/__tests__/review-job-end-diagnosis.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — A review-job test that feeds the real runReviewLoopOnce timeout output into runReviewJob and asse… (from web-everything/web-everything#7502 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-loop-cli.mjs:896` — A review-job test that feeds the real runReviewLoopOnce timeout output into runReviewJob and asserts the completion label names juror-timeout and carries a bounded, redacted error.
2. `we:scripts/operations/review-job.mjs:1594` — Pass finishArc null for `stopped: 'juror-timeout'`, with a review-job test asserting runExtraSeats and redTeamStatus are not called.
3. `we:scripts/operations/cli-adapter.mjs:1221` — A test that renders every `stopped` value driveRun can return and asserts error-bearing stops include the redacted error.
4. `we:scripts/operations/cli-adapter.mjs:1057` — Have the judge attach the effective provider and model to the timeout error, with a test using createDefaultJudge with a model override and a stub provider that times out.
5. `we:scripts/operations/review-job.mjs:626` — A test using createReviewJobIo with a temp dir: call writeEnded, then diagnoseEndedJob on the same dir and assert reason, lens, provider, model and head.
6. `we:scripts/operations/review-job-end-diagnosis.mjs:18` — Add newline, ESC and U+2028 to the hostile fixture and assert neither the diagnosis fields nor the logged line contains them.
7. `we:scripts/operations/review-job.mjs:626` — File a test that runs runReviewJob with createReviewJobIo({dir}).writeEnded and a stubbed timeout payload, then reads it back with diagnoseEndedJob using the same slug, pid and dir. As a class guard, require each new io seam to have a default-implementation test.
8. `we:scripts/operations/review-job-end-diagnosis.mjs:18` — File a table-driven test that puts newline, ESC, U+2028 and overlong values in every timeout field and asserts on both the diagnoseEndedJob output and the daemon log line.
9. `we:scripts/operations/review-job-end-diagnosis.mjs:18` — File one shared log-safe-field helper (remove controls, redact, then bound) with a control-split-token test, used by every path that puts untrusted record text into a log.
10. `we:scripts/operations/review-job-end-diagnosis.mjs:14` — File a shared bounded-JSON-read helper (open, then read at most cap+1 bytes from the descriptor) and a lint rule against statSync-size followed by readFileSync on the same path.
11. `we:skills-src/conveyor/__tests__/review-daemon-juror-timeout.test.mjs:8` — Add a deterministic control-character fixture and log assertion, with a targeted mutation check that removing normalization fails the test.
12. `we:skills-src/conveyor/__tests__/review-daemon-juror-timeout.test.mjs:22` — Add a deterministic scheduling test asserting immediate-retry precedence and subsequent yielding to a waiting peer.
13. `we:scripts/operations/review-job-end-diagnosis.mjs:14` — Use a bounded descriptor read and add a deterministic test that replaces or grows the file after inspection and asserts the maximum bytes requested.
14. `we:skills-src/conveyor/__tests__/review-daemon-juror-timeout.test.mjs:8` — Add parameterized control-character cases with explicit assertions on diagnostic fields and emitted logs; require those tests in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7502@e027d764aa5548a49ca29cdd6cfa6cd26c3c658b

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
