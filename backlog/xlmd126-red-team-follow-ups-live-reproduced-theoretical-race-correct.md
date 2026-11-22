---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/change-evidence/record.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race, correctness-in-normal-use] from web-everything/web-everything#7319 (head 2165f748d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7319 (reviewed head `2165f748dc49258050ba3e97abf4fb66e2b94791`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/change-evidence/record.mjs:76` — (failing-input, degraded) A newer unfinished required check is hidden by an older successful run
   - Scenario: Provide successful required check id 10, then same-name, same-producer check id 11 started before merge with status=in_progress and completed_at=null. The builder drops id 11 before selecting the highest id and records tested=pass and overall=pass using id 10. The same false pass occurs if id 11 finishes after merge. The newer attempt was unresolved at merge, so tested should be unknown instead of falling back to the earlier success.
   - Class: live-reproduced (basis: Read-only Node probes reproduced the false pass using both the checked-in #7289 fixture and a minimal complete input.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/change-evidence/record.mjs:69` — (edge-case, degraded) Editing a rejection after merge resurrects an earlier acceptance
   - Scenario: Start with a valid acceptance, then a trusted changes-requested comment created at 11:59 before a 12:00 merge. With updated_at=11:59, reviewed is unknown because the rejection revokes acceptance. Change only that rejection's updated_at to 12:01, representing a post-merge typo edit with the rejection unchanged. The builder excludes the rejection and changes reviewed and overall to pass. Unavailable merge-time comment history should produce uncertainty rather than restore revoked acceptance.
   - Class: live-reproduced (basis: A read-only Node probe changed only the rejection's updated_at and observed overall change from unknown to pass.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/change-evidence/record.mjs:153` — (edge-case, degraded) A same-second label removal is ignored
   - Scenario: Supply ordered timeline events: id 20 applies review:accepted through the trusted approver; id 21 removes it. Both have created_at=2026-11-21T10:00:02Z, before merge, with no later reapplication. The strict timestamp comparison ignores the removal and records presentAtMerge=true, approved=pass and overall=pass. Timeline order establishes that the label was removed, so approved should fail.
   - Class: live-reproduced (basis: A read-only Node probe with ordered events and increasing event IDs reproduced the false pass. No concurrent execution is required; the input uses second-resolution timestamps.)
   - Also class: theoretical-race
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
