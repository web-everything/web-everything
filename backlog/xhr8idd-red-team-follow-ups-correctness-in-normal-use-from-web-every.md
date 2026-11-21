---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-stall-classify.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7230 (head 1a4a23588)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7230 (reviewed head `1a4a235880d029f9aae3a48a445807fdac320917`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-stall-classify.mjs:318` — (failing-input, degraded) Published malformed findings are treated as publication pending, suppressing an existing operator hold.
   - Scenario: For a trusted advisory containing '1. [**CONFIRMED**] (failing-input, broken) 'we:scripts/foo.mjs:3' — Reject the invalid input before dereferencing its missing property.', the parser records a malformed finding-shaped line but returns no findings. With an existing round-cap record and persisted legacyHold evidence, redTeamRulingNeeded still produces an operator row. At ageMinutes=2 and approxSince=false, judgeRound produces latest=[], crossBroken=0, and the new classifier returns null. The published malformed evidence and known conflict should retain the operator item immediately; instead it dis
   - Class: correctness-in-normal-use (basis: An isolated probe using the actual parser, judge and classifier bodies reproduced the empty findings and null classification. Unrelated imports were stubbed because markdown-it is unavailable. Source tracing confirms persisted legacyHold evidence creates a non-publication-pending operator hold. This exercises the malformed-input behavior explicitly claimed by the PR and requires no attacker or concurrency assumption.)
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
