---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/flow-v0-interim/load.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7364 (head 259eb1041)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7364 (reviewed head `259eb1041d9eee1df85816886067f76d5b51b81f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/flow-v0-interim/load.mjs:41` — (edge-case, degraded) A state named timeout is incorrectly classified as an unsupported timer
   - Scenario: In we:review-definition.mjs, rename the accepted final state to timeout and update the accept transition's target accordingly. No timer field or behavior is added. load throws Unsupported features: timers with diagnostic sourcePath=/states/timeout. The recursive scan treats dictionary entry names as feature fields. This valid state name should load normally; unsupported-feature detection should inspect structural fields rather than arbitrary state identifiers.
   - Class: live-reproduced (basis: A read-only Node probe applied only this state rename and observed the timers loss report. The schema permits timeout as a state identifier.)
   - Also class: correctness-in-normal-use
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
