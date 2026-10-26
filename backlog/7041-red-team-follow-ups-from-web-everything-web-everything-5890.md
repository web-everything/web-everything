---
bornAs: x2leb5q
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5890 (head 83fe32fcf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5890 (reviewed head `83fe32fcf5320af6a16b244b24fcc97160399461`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-job.mjs:820` — (edge-case, degraded) An already-completed red team generates a false needs-you escalation on re-review.
   - Scenario: Re-review an accepted, unchanged head that already has a clean red-team seat row and its trusted result comment. runRedTeam returns status 'already-ran' when all effects are complete (we:review-extra-seats.mjs:1362). The new completion check excludes this status, so the job invokes non-policy settlement and publishes 'red team skipped (...); not cleared' despite the existing result. A read-only probe reproduced 'already-ran', confirmed redTeamForHead returned a result, and observed settlement execute with zero visibility-reader calls. Verify the existing head-bound result and suppress escalation
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
