---
bornAs: xjefqjf
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# ci-heal should re-run cancelled jobs before counting an attempt

MED priority hint. ## (held 2026-10-26 08:24 ET) ci-heal should re-run cancelled jobs before counting an attempt #5912: test-shard (3) was CANCELLED (not failed) on head d2e7cd0, the "test" aggregate went red, and ci-heal spent 3/3 attempts without ever re-running the cancelled shard. The R123 answer posted, but nothing re-runs CI on that head. Fix: when the only red required job is a cancelled shard (or its aggregate), ci-heal re-runs the failed/cancelled jobs (gh run rerun --failed) as a free attempt, once per head; it counts an attempt only on a real failure.

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
