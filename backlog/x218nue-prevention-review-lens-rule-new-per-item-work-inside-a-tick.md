---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/juror-timeout-route.mjs", "we:skills-src/conveyor/__tests__/review-daemon-juror-timeout.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:docs/agent/testing.md", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/operations/__tests__/juror-timeout-route.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Review-lens rule: new per-item work inside a tick loop must be wrapped per item, with a test that… (from web-everything/web-everything#7517 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/review-daemon.mjs:755` — Review-lens rule: new per-item work inside a tick loop must be wrapped per item, with a test that injects a throwing dependency and asserts sibling items still dispatch.
2. `we:skills-src/conveyor/review-daemon.mjs:755` — Single shared predicate for 'resume allowed' used by both daemon and CLI, plus a tick-level test that a CLI-refused resume produces a hold/ask line instead of a re-dispatch. File under JUROR-RETRY-HARDEN.
3. `we:scripts/operations/juror-timeout-route.mjs:33` — Wrap the product in `Math.ceil` and add a test that `nextJurorRoute` output always satisfies the provider-seam timeout validator.
4. `we:skills-src/conveyor/__tests__/review-daemon-juror-timeout.test.mjs:14` — Round-trip test: run the real juror-timeout handler twice through `runReviewLoopOnce`, then feed the saved run to `reviewRunEvidence` and `jurorTimeoutHold`. Add a cache-invalidation test that flips `retryEnabled` against a warm memo.
5. `we:skills-src/conveyor/review-daemon.mjs:755` — Add a daemon test with a throwing providerCapacity or readRuns that expects the tick to hold that PR and continue. Do this under the JUROR-RETRY-HARDEN gate that precedes enabling.
6. `we:scripts/operations/review-job.mjs:642` — Make the lookup wrapper total, returning a typed refusal, and add a runLoop test with a throwing findResumableRun. Track it in JUROR-RETRY-HARDEN.
7. `we:scripts/operations/__tests__/cli-adapter.test.mjs:260` — Add one review-job or review-loop test with a delegation-marker or Co-Authored-By builder in findings.read and a cross-vendor fallbackModel. It should assert the route is taken or skipped through the real evidence path.
8. `we:docs/agent/testing.md:6463` — Add the named deterministic cache regression to the normal test gate and require it to fail when the retry setting is removed from cache keys.
9. `we:scripts/conveyor/review-referral-hold.mjs:170` — Add a parameterized enabled/disabled counter-validation test to the normal test gate, injecting historical invalid records at the reader boundary.
10. `we:scripts/operations/review-job.mjs:642` — Add a deterministic launcher integration test named 'operator fresh request bypasses exhausted timeout resume' asserting fresh-review arguments when the live PR includes an operator wake comment.
11. `we:scripts/operations/review-loop-cli.mjs:800` — Use one shared timeout-record predicate and add a deterministic CLI regression named 'missing seatTimeouts with exhausted retry marker never dispatches', asserting zero judge calls for explicit and automatic resume.
12. `we:docs/agent/testing.md:6463` — Add a deterministic reader-level regression covering both warm-memory and persisted-cache reuse, including enabled-to-disabled transitions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7517@129442a926e8eebf7ec7ce4c531000081fdc7c88

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
