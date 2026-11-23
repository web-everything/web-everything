---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7367 (head a99d381ad)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7367 (reviewed head `a99d381addb7a55b8d535bb2312a2afffb385410`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:3015` — (edge-case, degraded) Incomplete-check dependency deferrals hide the operative check failure
   - Scenario: PR 42 has rowsComplete=false, blockedBy=[43], and blocker 43 remains open. The new branch adds a dependency deferral. buildSkipReasons prioritizes that record over the skipped verdict, replacing the incomplete-check retry instruction with only 'blockedBy unlanded: 43'. Operators lose the check-read failure that will still prevent enqueue after 43 lands. Preserve the incomplete-check reason alongside dependency information.
   - Class: live-reproduced (basis: A read-only Node probe of production buildSkipReasons using the new branch's emitted record reproduced the reason replacement. Source inspection establishes the classification and deferral sequence. Full CLI probing was unavailable because repository dependencies are missing.)
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
