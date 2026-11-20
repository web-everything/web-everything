---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-status-labels.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7236 (head 6a28dc635)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7236 (reviewed head `6a28dc635352f022f9be6e6686d35074599cad8d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/red-team-status-labels.mjs:189` — (edge-case, degraded) The final check read occurs after the last head guard
   - Scenario: Start with head A and red-team:pending. Let the first two check reads return true and every head read return A. During the third check read, advance the PR to head B while returning A's successful check. The function then writes red-team:clear and removes pending from B without another head read. It should detect B and refuse the stale transition.
   - Class: theoretical-race (basis: An isolated probe of the source-extracted sync function reproduced this interleaving and recorded a clear-label write while the provider's current head was B. The production failure requires a concurrent head update during the final remote check read; no live concurrent update was tested.)
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
