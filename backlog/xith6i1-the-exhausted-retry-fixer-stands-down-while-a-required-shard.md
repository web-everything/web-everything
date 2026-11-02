---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# The exhausted-retry fixer stands down while a required shard is still pending

MED priority hint. ## (held 2026-10-27 18:56 ET) The exhausted-retry fixer stands down while a required shard is still pending #5912 at 22:51Z: the fixer stood down saying "the automatic retry after ci-heal-exhausted was used and test is still red on 4ca5ac6". Then 9 of 10 shards, smoke and integration were green and test-shard (6) was still PENDING. The red "test" was the aggregate from an earlier attempt. Fix: the exhausted-retry check waits for every required job on the head to finish, and reads the latest attempt per job, before standing down. Prove it on #5912.

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
