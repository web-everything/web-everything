---
bornAs: xees7mw
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5241 (head a68cb19fb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5241 (reviewed head `a68cb19fb55ea02f6d1ac70769c667204cde4efd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:
1. `we:scripts/lib/enqueue-on-event.mjs:500` — (edge-case, degraded) Catch-up capacity ignores successful event drains and can overfill the queue.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #6120.

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
