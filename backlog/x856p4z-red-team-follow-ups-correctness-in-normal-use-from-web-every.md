---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7181 (head d48beb109)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7181 (reviewed head `d48beb109060116a9ee0a52f832f12d7693f5ea2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:297` — (failing-input, degraded) Legacy comparisons read nonexistent settings and a boolean as concurrency caps
   - Scenario: Run the collector with committed settings, complete empty holder inventories, and a fresh 30-unit snapshot. The blocker, redTeam, and build rows produce legacyDecision='unknown': mainFixCapacity.pastFixCap is boolean true, redTeamQueue.minConcurrent is absent, and maxConcurrentBuilds is absent from merged settings. Red-team configuration lives under redTeam.queue, while build concurrency belongs to the build dispatch policy. These healthy inputs should produce comparisons against the actual legacy admission rules; instead, every run lacks usable comparisons for these populations.
   - Class: correctness-in-normal-use (basis: Confirmed the committed setting values and reproduced the three unknown legacy decisions by executing the collector body with the actual merged settings and injected complete source reads. The isolated probe stubbed admission-policy loading because the checkout lacks gray-matter, which prevents importing the full adapter dependency graph.)
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
