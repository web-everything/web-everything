---
bornAs: xdjlxch
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5465 (head d3c0c02fd)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5465 (reviewed head `d3c0c02fd8a06bd85dcc2fcc08252aa03f3a4ec7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:2386` — (edge-case, degraded) An optional CI failure bypasses reviewer liveness and permits duplicate session reviews.
   - Scenario: Use a review:pending PR with green standards, test-shard (1), and required test; an optional-lint failure completed 20 minutes ago; and a working review-7 agent with pidAlive=true. Default joining removes that live reviewer from the liveness guard and emits another review. With joining disabled, the same input correctly returns live-process. Driving two successive plans through the session dispatcher with mocked spawn effects produced two additional launches while the original reviewer remained live. Restrict the liveness exception to an actually owed CI repair, preserving protection against d
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
