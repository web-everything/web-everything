---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Every main push CI run's first attempt is cancelled

MED priority hint. ## (held 2026-10-26 10:01 ET) Every main push CI run's first attempt is cancelled On 2026-10-26, main CI attempt 1 was cancelled on 574b7d16e, a491b8a6c and 6c38aee9a; the recovery watch (#5975) re-ran each, and attempt 2 passed. Each cancel costs ~30–60 min of main CI. Find what cancels attempt 1: a concurrency group with cancel-in-progress shared with merge-queue/PR runs, a smoke job timeout, or runner pre-emption. Fix the cause so main CI is one attempt; keep the retrigger as a backstop.

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
