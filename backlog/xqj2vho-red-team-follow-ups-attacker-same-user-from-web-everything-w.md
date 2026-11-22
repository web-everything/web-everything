---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7246 (head b2709b079)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7246 (reviewed head `b2709b079f8c9fbca8bbecc1c29f00331864ed0d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:5785` — (security, broken) Verification-hold checking can execute a filter before the filter-driver refusal.
   - Scenario: In a valid leased lane, configure filter.sneaky.clean, assign a tracked file to that filter through .git/info/attributes, modify that file, and leave a recent corrupt .git/.lane-verify. Run branch --lane=N --session=&lt;holder&gt; --name=lane/probe --dry-run. The early checkLaneHold call invokes laneStateSnapshot and git status --porcelain, which can execute the clean filter before the later laneFilterDrivers check. The command should reject the filter configuration before any status call, including during dry-run.
   - Class: attacker-same-user (basis: An in-memory filesystem and child-process probe of the actual checkLaneHold helper confirmed that a recent corrupt verification marker triggers git status before returning its refusal. Source inspection places this call before the new filter guard. Exploitation requires the lane holder's existing write access to Git configuration, attributes and verification metadata; no separate-user privilege boundary was demonstrated.)
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
