---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/operations/runner-freshness.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, attacker-same-user] from web-everything/web-everything#7208 (head a1108d650)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7208 (reviewed head `a1108d6502d9c8853af57711315eebf793813839`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:3672` — (failing-input, degraded) release --discard cannot recover conflicting tracked edits in a pinned lane
   - Scenario: Pin a branch where file.txt differs from main, modify file.txt without committing, then run release --lane=N --discard. The discard option bypasses the work and dirty-state refusals, but the subsequent checkout lacks --force. Git refuses because local changes would be overwritten, retaining the pinned lease. The explicitly authorized discard should recover tracked edits while preserving the intended protection for ignored files.
   - Class: correctness-in-normal-use (basis: The discard path executes the same non-forced checkout as ordinary release. Git's checkout help confirms that --force discards local modifications. Existing recovery tests cover committed changes, not conflicting uncommitted tracked edits; this was not reproduced end to end in the read-only sandbox.)
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/runner-freshness.mjs:23` — (security, broken) The new pinned freshness fetch can execute a lane-configured transport command
   - Scenario: After acquiring a pinned runner, a worker sets remote.origin.url to a local repository and remote.origin.uploadpack to a shell command, then invokes open-pr. The new freshness fetch runs that command before rejecting any invalid remote evidence. It lacks lane-pool's explicit --upload-pack override and transport-config cleanup. Lane-controlled transport commands should be neutralized before this fetch.
   - Class: attacker-same-user (basis: Requires a same-user worker able to edit the lane's .git/config; no remote-only exploit is established. A read-only ls-remote probe using the same hardening environment and equivalent remote configuration printed WE_PIN_TRANSPORT_EXECUTED, proving the environment pins do not suppress uploadpack execution.)
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
