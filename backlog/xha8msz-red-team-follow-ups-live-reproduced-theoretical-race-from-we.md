---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/change-evidence/record.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7319 (head 931fb84d4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7319 (reviewed head `931fb84d4a5d880a98820ac326266eff794558b0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/change-evidence/record.mjs:118` — (edge-case, degraded) Same-second label removal produces a false approval pass
   - Scenario: In the supplied fixture, supply an authorized review:accepted label event followed by an unlabeled event with the same created_at timestamp and a higher event ID. The approved clause returns pass and records presentAtMerge=true, although the label was removed. Events within GitHub's timestamp precision must be resolved using their sequence rather than requiring a strictly later timestamp.
   - Class: live-reproduced (basis: A read-only Node probe used ordered labeled/unlabeled events at 2026-11-21T09:43:20Z and observed approved=pass with presentAtMerge=true.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/change-evidence/record.mjs:49` — (failing-input, degraded) A newer in-progress check is ignored in favor of an older success
   - Scenario: Add a higher-ID run for the fixture's required test check, started before merge, with status=in_progress, conclusion=null and completed_at=null. Filtering by completed_at discards that attempt before choosing the highest ID, so tested remains pass using the older successful run. The newer unfinished attempt should make the evidence inconclusive.
   - Class: live-reproduced (basis: A read-only Node probe added this API-shaped run to the fixture and observed tested=pass with the older check ID retained.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/change-evidence/record.mjs:42` — (edge-case, degraded) Post-merge edits can erase a pre-merge review revocation
   - Scenario: After the fixture's acceptance and restamp, add a trusted changes-requested comment created before merge, then edit that comment after merge. The updated_at filter removes the rejection entirely and reviewed returns pass using the earlier acceptance. When an edited comment prevents reconstructing the merge-time review state, the result should be unknown rather than resurrecting a potentially revoked acceptance.
   - Class: live-reproduced (basis: A read-only Node probe added a trusted rejection created at 2026-11-21T11:00:00Z and updated at 2026-11-22T00:00:00Z; reviewed returned pass.)
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
