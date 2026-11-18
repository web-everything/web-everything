---
bornAs: xx229sx
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Re-alert a stood-down PR when its pending CI resolves

MED priority hint. ## (held 2026-10-27 21:43 ET) Re-alert a stood-down PR when its pending CI resolves #5912 stood down at 22:51Z while shard 6 was pending. Shard 6 then failed for real (number-at-birth-cli ERR_MODULE_NOT_FOUND, a clash with #5958) and no event fired. The orchestrator had said it would follow up but tracked nothing, and the sweeps were told to skip it. Fix: (1) when a pending required job on a stood-down head finishes, re-emit needs-you with the failing test name and a pick; (2) the orchestrator never defers with "I'll tell you" without a one-shot check (CronCreate) or a watch entry; (3) sweep skip-lists expire after one sweep.

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
