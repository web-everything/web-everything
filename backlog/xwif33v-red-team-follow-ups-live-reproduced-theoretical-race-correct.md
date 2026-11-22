---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/change-evidence/record.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race, correctness-in-normal-use] from web-everything/web-everything#7319 (head bd1543100)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7319 (reviewed head `bd1543100acc6592427443a7b0375778d5da3b7b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/change-evidence/record.mjs:49` — (failing-input, degraded) An unfinished newer check attempt can leave tested falsely passing
   - Scenario: Add a higher-ID GitHub Actions test run to the #7289 fixture with started_at before mergedAt, status=in_progress, conclusion=null and completed_at=null. buildChangeEvidence returns tested=pass using the older successful run. Filtering by completed_at discards the unfinished attempt before selecting the highest ID. The newer pre-merge attempt should make tested unknown rather than reuse the older success.
   - Class: live-reproduced (basis: A read-only Node probe reproduced tested=pass with this concrete fixture mutation. The existing test also explicitly intends incomplete newer attempts to prevent passing.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/change-evidence/record.mjs:118` — (edge-case, degraded) Approval removal within the same second is ignored
   - Scenario: Follow the fixture's review:accepted label event with an unlabeled event having a larger event ID and the identical created_at timestamp, 2026-11-21T09:43:20Z, before merge. buildChangeEvidence returns approved=pass, presentAtMerge=true and overall=pass despite the removal. The strict timestamp comparison misses sequential events within one timestamp second; timeline order must determine the final label state.
   - Class: live-reproduced (basis: A read-only Node probe reproduced the false approval and overall pass. Both events use the timestamp precision present in the supplied forge fixture.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/change-evidence/record.mjs:66` — (failing-input, degraded) An explicit disclaimer of reviewer independence still produces reviewed=pass
   - Scenario: Add the producer's 'Independence NOT established for this clearance' warning to the fixture's accepted review, retaining its valid SHA/prevention markers and restamp. buildChangeEvidence returns reviewed=pass and overall=pass. we:review-set-label.mjs permits unknown-author and unknown-clearer acceptances and emits this warning, but the new writer checks only whether GitHub logins differ. It should preserve unknown independence and prevent a restamp from upgrading that acceptance to an independent review pass.
   - Class: live-reproduced (basis: A read-only Node probe reproduced both pass verdicts. Inspection of we:review-set-label.mjs confirms these explicitly unproven acceptances are permitted producer output, and its renderer emits the ignored warning.)
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
