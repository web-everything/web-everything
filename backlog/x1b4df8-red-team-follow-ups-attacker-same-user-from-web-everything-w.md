---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7246 (head fae372052)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7246 (reviewed head `fae3720520c385e97822d8a940ce6cfc568c8724`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:5665` — (security, broken) Lane-owned Git filters can execute through the sanctioned command
   - Scenario: In a leased lane, add '* filter=probe' to .git/info/attributes and configure filter.probe.smudge to a shell command. Run branch --lane=1 --session=&lt;holder&gt; --name=lane/test --from=&lt;commit-changing-a-tracked-file&gt;. The config passes releaseTrackedChanges because its checks omit laneFilterDrivers; switch then executes the configured command. Reject lane-owned filter drivers before status or switch, as the existing safety scanner does.
   - Class: attacker-same-user (basis: Requires the holder or another same-user process to modify lane Git configuration and attributes. A read-only probe confirmed these filter keys produce no branch refusal keys, and Git executed harmless clean and smudge commands under the same hardening and reporting pins. The complete branch operation was not executed.)
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
