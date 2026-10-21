---
bornAs: xaqsggh
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5480 (head 73c60b00f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5480 (reviewed head `73c60b00fd4a95fcceb0ac05606e7f8c6e790a18`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:572` — (edge-case, degraded) A pre-staged green event blocks catch-up without being processed by catchUp().
   - Scenario: Enable catch-up, provide an eligible pre-stage cache entry for PR #42, record check_run.completed=success(at)1 for it, then call handle.catchUp() with no retained catch-up work. The new condition suppresses readCandidates because #42 has a staged green event. However, line 605 excludes #42 because catchUpOnly is true and the event has no catchUp flag. Repeated catchUp() calls neither list candidates nor consume the event. This stalls catch-up for unrelated ready PRs in the documented daemon mode that calls catchUp() between back-to-back passes. An in-memory probe of the source returned zero listi
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
