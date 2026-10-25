---
kind: task
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Merge-gate re-runs after a human clearance

#5169 (2026-10-15 16:45 ET): merge-gate last ran at 20:06Z, clear-human came at 20:09Z, the label swap triggered no new run, and it was re-run by hand through the REST API. Want: clear-human (and any ruling changing gate inputs) re-triggers merge-gate on the current head, or the drain re-runs it when the last run is older than the last clearance; record an event when the gate is stale after clear-human. Prove: the next clearance gets a fresh gate run with no manual step.

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
