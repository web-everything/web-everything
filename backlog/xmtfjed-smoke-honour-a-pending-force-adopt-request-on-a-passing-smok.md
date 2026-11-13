---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-13"
tags: []
---

# Smoke: honour a pending force-adopt request on a passing smoke and match it by carried overlay, not final sha

2026-11-13 (fix-daemon bootstrap). In the daemon smoke step (we:scripts/conveyor, smoke lines 688-698) a pending force-adopt request is only consulted on a FAILED smoke; a passing smoke goes to ordinary adoption and ignores it. forceRequestFor also requires the exact final sha, so main movement orphans the request. Fix: honour the request on pass and match by carried overlay.

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

## Duplicate admission

capability-search found no matching open card
