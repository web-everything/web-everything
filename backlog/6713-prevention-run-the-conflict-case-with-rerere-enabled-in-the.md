---
bornAs: xdifg8k
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/conveyor/__tests__/prepare-policy-settings.test.mjs", "we:scripts/operations/prepare-batch.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/ci-card-only.mjs", "we:scripts/operations/__tests__/prepare-batch.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/__tests__/ci-card-only.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Run the conflict case with rerere enabled in the fixture env so the -c rerere.enabled=false overr… (from web-everything/web-everything#5486 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/probation-build-run.test.mjs:1` — Run the conflict case with rerere enabled in the fixture env so the `-c rerere.enabled=false` override is load-bearing.
2. `we:scripts/conveyor/__tests__/prepare-policy-settings.test.mjs:100` — Add table tests at each declared bound (0, 1, 100, 101, and env 'abc') for batchSize, batchMaxParallel and aheadCount.
3. `we:scripts/operations/prepare-batch.mjs:28` — Add a test that every lane session minted by a batch is either released by the coordinator or matches the watcher's slug derivation. A lint on session slugs minted outside `dispatch-lane`'s slug function would also catch it.
4. `we:scripts/operations/prepare-batch.mjs:8` — Make the daemon admit a batch against the external cap by its worker count, and add a two-batch test asserting total in-flight external workers ≤ cap.
5. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1760` — Add a reader round-trip test that feeds a real `runPrepareBatch` result through `cliListSettledBuilds` and asserts every field the daemon consumes. Soak fixtures should be built from that reader and not hand-written.
6. `we:scripts/operations/probation-build-run.mjs:523` — Add a coordinator test with a child result of 'prepare-already-done' and assert it is not recorded as a failure hold. Alternatively, treat PREPARE_HANDLED_OUTCOMES as non-drop outcomes in `runPrepareBatch`.
7. `we:scripts/operations/review-loop-cli.mjs:451` — Add a settings-precedence test, or a we:docs/agent/testing.md note, stating that seatsByTouchSet=off yields the full roster regardless of new lanes. Prefer a check:standards rule that a seat-reducing default must be gated behind the existing off-switch.
8. `we:scripts/ci-card-only.mjs:23` — Have the net read expose per-file mode, and make isCardOnlyDiff or the light-lane gate refuse non-regular entries (120000/160000). Add a ci-card-only test for a symlink entry.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5486@b49311bfb3f4d908453640b57a049362abf03d7c

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
