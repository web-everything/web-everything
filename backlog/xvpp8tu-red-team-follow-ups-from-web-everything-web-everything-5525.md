---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5525 (head 2e60c7be5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5525 (reviewed head `2e60c7be5bb12856b299b861cee5839c6c35e18b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:2322` — (edge-case, degraded) Cascade replans still yield to a target already refused during this pass
   - Scenario: In a direct-merge pass, let X=#5482 change one line in we:shared.mjs, Y=#5461 change 100 lines there, and Z change an unrelated file. All initially have merge verdicts and review:accepted; X is inside its 45-minute yield budget. Y then fails fresh pre-merge revalidation, setting its cloned entry in remaining to skip (line 6589), while Z merges and triggers another cascade iteration. replan passes the original verdicts to buildOverlapRows (line 6203), so the new filter still sees Y as merge. X remains deferred to Y although this pass has already refused Y. A read-only probe using the exact reposit
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
