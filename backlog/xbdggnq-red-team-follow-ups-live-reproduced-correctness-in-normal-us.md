---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7567 (head 86e804f4a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7567 (reviewed head `86e804f4a4422a5a9ca6bd1650315e8d30a63f35`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/fix-run.mjs:1278` — (failing-input, degraded) Multiline fixer summaries suppress otherwise valid no-code evidence
   - Scenario: With a valid operator ruling, matching heads, clean worktree and owned claim, return finalMessage 'Already repaired.\n\nTests pass.'. The launcher passes this unchanged as reason, but buildNoCodeOwedStandDown rejects newline characters. The producer emits no trailer and requests operator inspection. Normalize and bound the ordinary agent summary before constructing the record so this authorized no-change exit emits its terminal evidence.
   - Class: live-reproduced (basis: Executed the actual builder and emitter source with matching fresh-state fixtures. The single-line summary emitted successfully; the equivalent multiline summary returned emitted:false and wrote nothing.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/rearm-review.mjs:292` — (edge-case, degraded) Superseded formal change requests permanently block no-code authorization
   - Scenario: A reviewer submits CHANGES_REQUESTED and subsequently APPROVED on the same head. Supply both historical review records alongside an otherwise authorized first no-code resume. The new check rejects the historical CHANGES_REQUESTED even though that reviewer's later approval supersedes it. The default producer reads the complete review history without reducing it. Evaluate each reviewer's effective latest submitted review before deciding whether a formal repair hold remains.
   - Class: live-reproduced (basis: Executed the actual authorization and window functions with an authorized thread and chronological CHANGES_REQUESTED/APPROVED records for one reviewer. Authorization refused; the same input containing only that reviewer's latest approval allowed the resume. Forge and identity boundaries were fixture ports.)
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
