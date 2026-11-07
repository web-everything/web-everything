---
kind: story
size: 5
status: open
scope: ["we:scripts/__tests__/rust-scan-stdout-flush-parity.test.mjs", "we:scripts/lib/verify-shard-run.mjs", "we:scripts/lib/__tests__/verify-shard-run.test.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/conveyor/await-verify-pass.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A test file whose suites are all skipped on the host (describe.skipIf(!hasCargo)) is permanent INVENTORY-INCO…

Flow-sim gap R6c-G2, class K19 (proof or inventory check mismatch). Failing input: Host (verify daemon / lane / prototype worktree) without cargo. Selection or sharded run includes we:scripts/__tests__/rust-scan-stdout-flush-parity.test.mjs (or the other three rust-scan-*-parity tests). verify-shard run (or prototype combined test) executes that file; vitest reports status passed/skipped with only pending ass… Cited: we:scripts/__tests__/rust-scan-stdout-flush-parity.test.mjs:23, we:scripts/lib/verify-shard-run.mjs:66-67, we:scripts/lib/__tests__/verify-shard-run.test.mjs:425, we:scripts/lib/verify-shard-run.mjs:310-322, we:scripts/lib/verify-shard-run.mjs:345-348. Soak-break sketch: Fixture: shard of 2 files, one with all assertions 'pending', one passing; stubbed execute returns exit 0 with that report. Action: runShards. Assertion (fails today): result is 0 (GREEN) or a RED naming the skipped file, not exit 75 on every rerun. Also asse…

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
