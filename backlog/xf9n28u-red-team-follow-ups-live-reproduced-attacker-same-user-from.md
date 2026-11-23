---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/flow-engine/shadow.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user] from web-everything/web-everything#7364 (head 2224f5124)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7364 (reviewed head `2224f5124054fb3a3c5b7511dbf2850ff72776fb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/flow-engine/shadow.mjs:124` — (failing-input, degraded) Shadow comparison silently accepts an attempt-only disagreement.
   - Scenario: Observe a bounced completion for o/r#7 with classified.attempt=1. Supply an engine.plan wrapper that delegates to the real planner and changes only the returned attempt to 2, retaining key='review:o%2Fr%237:1.1'. fullStep discards attempt without folding its returned value into the key, so the observer reports agreement=true and appends attempt=2 despite the definition's maximum of 1. It should report disagreement; otherwise invalid replacement-engine output becomes clean comparison evidence and poisons subsequent replay.
   - Class: live-reproduced (basis: The actual shadowReviewStep was exercised with in-memory filesystem, completion, and lock adapters. The captured Transition contained attempt=2 and agreement=true; the injected engine changed only attempt.)
   - Also class: attacker-same-user
   - Claude's re-check: demonstrated break

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
