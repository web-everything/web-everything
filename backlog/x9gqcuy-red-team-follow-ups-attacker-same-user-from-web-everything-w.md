---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7246 (head 693c72949)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7246 (reviewed head `693c7294907bd62f208b86ee97988ba4cf16ec03`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:5793` — (security, broken) Lane-local Git filters can execute commands during branch validation, including dry-run.
   - Scenario: In a leased lane, configure filter.probe.clean as 'printf FILTER_EXECUTED &gt;&2; cat', assign a tracked file to filter=probe in .git/info/attributes, and change that file's cached mtime with touch. Run branch --lane=N --session=&lt;holder&gt; --name=lane/probe --dry-run. releaseTrackedChanges runs Git status without rejecting filter drivers, allowing the configured shell command to execute before validation finishes. The hardening pins cannot disable repository attributes or arbitrary filter drivers. The command should reject lane-local filter drivers before any status or checkout operation.
   - Class: attacker-same-user (basis: Requires a holder able to modify the lane's Git configuration and attributes; no cross-user exploit was demonstrated. An in-memory control-flow probe accepted filter.probe.clean through the actual config classifiers, and a harmless read-only Git probe confirmed filter execution with the hardening environment. The shared hardening module explicitly documents this limitation and provides laneFilterDrivers for refusal.)
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
