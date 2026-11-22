---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/provider-rotation.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7338 (head 14bad3ea4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7338 (reviewed head `14bad3ea4822376f469ac8217f4fddbf4ae5483c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/provider-rotation.mjs:74` — (edge-case, degraded) Computing shares freezes caller-owned arm metadata, violating engine purity.
   - Scenario: Load the shipped policy, set policy.kinds.build.arms[0].metadata = { attempts: 0 }, and call drawArm with kind 'build', subject 'repo#1', and all three providers available with usedPct 20, hoursToReset 4, and manualResetsHeld 0. Routing succeeds, but subsequently incrementing metadata.attempts throws TypeError. effectiveShares shallow-copies each entry, preserving the metadata reference, then recursively freezes it. Computing a route should leave caller-owned objects mutable; nested properties must be copied or omitted before freezing results.
   - Class: live-reproduced (basis: A direct Node probe using the shipped policy observed the caller's metadata become frozen and its subsequent update throw TypeError.)
   - Also class: coverage-or-style
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
