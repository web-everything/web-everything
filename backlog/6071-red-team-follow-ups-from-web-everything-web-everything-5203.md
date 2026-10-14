---
bornAs: x1q1f74
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-list-paged.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5203 (head ee3f3b3bf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5203 (reviewed head `ee3f3b3bf56019faed946942ef3218f110e5214b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-list-paged.mjs:143` — (edge-case, degraded) A supported page size can exceed the snapshot’s 500-row cap.
   - Scenario: Set prListPaging.pageSize=30 and provide 510 open PRs. The loop appends the complete seventeenth page after collecting 480 rows. A fetchSnapshot probe returned limit=500, count=510, truncated=false and performed 510 hydration calls. The requested maxRows=500 must bound returned rows and hydration; this input should return 500 rows with truncated=true.
   - Claude's re-check: The loop only checks 'rows.length &lt; maxRows' between whole pages and never slices. With pageSize 30, 16 pages give 480 rows, so a 17th full page is appended (510 rows total). 'truncated' is 'hasNextPage && ...', so it is false when that page is last. 'fetchSnapshot' then reports 'count' 510 against 'limit' 500 and hydrates every row.

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
