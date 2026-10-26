---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5937 (head 4c0c3ff69)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5937 (reviewed head `4c0c3ff69c08ca5288139e275d57976019c292ee`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/plan.mjs:603` — (edge-case, degraded) A stack-contained prerequisite incorrectly blocks pinned-base deferral.
   - Scenario: Start at A with f=0,g=0. B branches from A with f=1; running HEAD carries B. New main M branches from A with f=2. Prerequisite U branches from A with g=1. Top T has parents B,M,U and resolves to f=3,g=1. Register overlays in order [B pinned:true, U, T], with stackMode=tops and edgeResolve=false. planOverlayStacks correctly marks U stack-contained in T, but the new blocked check counts U as an unrelated newcomer, prevents B's deferral, and returns pinned-overlay-conflict before trying T. U cannot compete for priority because it is skipped. Expected: apply T and retain both contained bases. A re
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
