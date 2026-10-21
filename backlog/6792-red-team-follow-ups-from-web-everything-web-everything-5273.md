---
bornAs: xofmbrx
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/human-surface-repark.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5273 (head 45c5481f1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5273 (reviewed head `45c5481f1f537a9b31648bd4d3f9feef28f08197`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/human-surface-repark.mjs:67` — (failing-input, degraded) Threads with 100 or more comments are permanently excluded from re-parking.
   - Scenario: Use an open PR at an unchanged head, touching we:.github/workflows/ci.yml, with review:accepted, no human hold, and exactly 100 ordinary comments containing no clearance. Even when readComments successfully returns the entire thread, the fresh state's 100-comment page causes an unconditional skip. Repeated sweep probes return 'fresh comments may be truncated' without changing labels; every subsequent tick repeats the skip. The sweep should obtain fresh complete evidence and re-park this eligible PR rather than permanently abandoning all threads at the page limit.
   - Claude's re-check: The guard 'state.comments.length &gt;= LIST_COMMENTS_PAGE_SIZE' skips unconditionally, even when readComments returned the full thread. The test 'exactly full fresh page' pins this. A PR with 100 or more comments is skipped on every tick and never re-parked.

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
