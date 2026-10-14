---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5241 (head 8e916e9c6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5241 (reviewed head `8e916e9c6c1624e5f03ef26f58e9414af5743519`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:296` — (edge-case, degraded) A timeline-query failure suppresses independently available acceptance history.
   - Scenario: List ready PRs #1 and #2 successfully, then fail their label-timeline query with HTTP 502. Their comment reader remains available: #1 was accepted October 12 and #2 October 1. Because comment reads are inside if(times.ok), neither thread is read, both ordering timestamps remain null, and capacity=1 selects #1 by number. The probe confirmed commentReads=[] and selected=[1]. The primary acceptance source should still be read independently of failure in the ready-time fallback query, selecting #2.
   - Claude's re-check: The readComments call sits inside 'if (times.ok) for (...)'. When the timeline query fails, no acceptance history is read, so firstAcceptedAt stays unset and ordering falls back to PR number.

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
