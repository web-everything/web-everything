---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-events-worker/core.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user] from web-everything/web-everything#7459 (head a5fad2fba)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7459 (reviewed head `a5fad2fba128abc04b9a54cd28d519abe6fa5360`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-events-worker/core.mjs:132` — (edge-case, degraded) Merge-group parser mistakes the target branch name for the PR number
   - Scenario: For PR #456 targeting branch pr-123-release, send a signed merge_group.checks_requested delivery with head_ref refs/heads/gh-readonly-queue/pr-123-release/pr-456-abcdef. The unanchored regex captures 123. The receiver returns 202, the port reports gap=false, and foldEvents marks only o/r#123 dirty, leaving #456 unmarked. The parser should identify #456 from the final queue-ref component; otherwise the affected PR waits for reconciliation.
   - Class: live-reproduced (basis: Reproduced locally through signed handleRequest intake, the event log, readChangeEvents, and foldEvents. Observed prs=[123], only o/r#123 marked, and no o/r#456 mark. git check-ref-format also accepted target branch pr-123-release.)
   - Also class: attacker-same-user
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
