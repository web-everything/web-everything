---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7246 (head fc8cf62a5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7246 (reviewed head `fc8cf62a55263bdf8854c85a3de26d276874a242`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:5630` — (security, broken) The branch path permits lane-configured smudge commands
   - Scenario: After acquiring a lane, configure filter.probe.smudge to execute a command and add 'file.txt filter=probe' to .git/info/attributes. Run branch with --from pointing to a commit that changes file.txt. The validation accepts this configuration, and switching invokes the configured command despite the hook hardening. The branch path should reject local filter drivers before running worktree-sensitive Git commands.
   - Class: attacker-same-user (basis: Requires write access to the lane's Git configuration and attributes. The actual validation functions accepted a configuration recognized by laneFilterDrivers as unsafe. A read-only Git filter probe also executed a harmless marker command under the shared hardening pins; attributes were supplied through a pipe. No cross-user attack was demonstrated.)
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
