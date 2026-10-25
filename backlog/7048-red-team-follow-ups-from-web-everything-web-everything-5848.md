---
bornAs: xut7p2m
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/auto-rebase.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5848 (head e32b7421a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5848 (reviewed head `e32b7421aba9dab01294fae74b697d2d6024f5a3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:229` — (edge-case, degraded) Running admission from the temporary clone bypasses the host's heavy-command queue.
   - Scenario: On a workstation with an existing workspace/.lanes pool, leave LANE_POOL_ROOT unset and start a repair with selected tests while the host's admission slots are occupied. The worker executes the scratch clone's we:heavy-admission.mjs from that same temporary clone. Both checkoutRoot and the module's ownCheckout therefore derive the temporary directory's absent .lanes pool; admissionBypassReason returns no-pool and Vitest runs without acquiring a host slot. A probe of the real exported helpers confirmed that the daemon checkout uses the workspace pool while the scratch checkout bypasses it. Multipl
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
