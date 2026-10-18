---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5510 (head e1cd74d05)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5510 (reviewed head `e1cd74d057b14538be763a4a6635b692a5f650be`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/review-referral-hold.mjs:264` — (edge-case, degraded) The missing-comment exception races an original pass that is still posting
   - Scenario: The original red-team worker saves its clean seat row, reads an empty comment thread, and starts a slow comment POST. Its review job slot has already been dropped before the added seats run. A daemon tick now sees saved evidence and no posted marker, grants and claims the new exception, and starts a retry while the original POST remains pending. Both workers can read no marker and post. A controlled interleaving of completeRedTeam, the real enrichment/claim functions, and resumeSavedRedTeam produced two identical advisory comments; both calls reported 'posted'. The reservation serializes retry
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
