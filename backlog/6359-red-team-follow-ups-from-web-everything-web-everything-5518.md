---
bornAs: x62yca7
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5518 (head 797e51838)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5518 (reviewed head `797e518382c68f53af3fec8c051ff2af0d9d2493`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:2322` — (edge-case, degraded) Cascade refusals remain overlap targets because the filter reads stale verdicts
   - Scenario: With the setting enabled, let accepted PRs #10 and #20 change we:shared.mjs by 1 and 100 lines respectively, and #30 change an unrelated file. All initially have decision=merge; #10 is inside its yield budget. The first plan readies #20/#30 and defers #10. If fresh revalidation refuses #20 and #30 merges, the cascade replans. Refusal changes only the cloned remaining entry (line 6589), but replan passes the original verdicts to buildOverlapRows (line 6203). The new filter therefore still sees #20 as merge: #10 remains deferred to a PR already refused this pass, and the cascade exits with nothing
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
