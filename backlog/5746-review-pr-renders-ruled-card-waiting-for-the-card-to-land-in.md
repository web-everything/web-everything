---
bornAs: xhr079k
kind: story
size: 1
status: open
scope: ["we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# review-pr renders "ruled card -- waiting for the card to land" instead of "Awaiting a ruling"

Held item 211, part (3) only (session 2026-10-10; stuck-PR class; build after #4795 merges). Parts (1) and (2) -- record-referral-ruling-io judging card readability against origin/main, and we:scripts/lib/referral-card-readable.mjs falling back to origin/main -- are being built now by another worker. Live #4708: the operator ruled card -> 5727 at 16:47Z; the card reached main 18:30Z (#4793) but the review daemon's build lagged, so the 17:44Z review re-asked the same question (identical advisory). Fix (3): we:scripts/operations/review-pr.mjs renders "ruled card -- waiting for the card to land" instead of "Awaiting a ruling" when a `card` ruling exists but the card is not yet readable. Evidence: replay (daemon backlog -> pending; main -> none).

## Acceptance

- [A1] **Executable** — a test with a `card` ruling on a card not yet on the daemon build renders "waiting for the card to land", not "Awaiting a ruling".
- [A2] **Live** — the next such PR shows the new line.

## Non-goals

- [N1] Parts (1) and (2) of item 211 (being built separately).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: card id from the ruling record only.
2. **Truncated reads** — If the ruling record cannot be read, keep today's text.
3. **Shared state files** — n/a: render only.
4. **Fail closed** — Unknown state -> today's text.
5. **Identity scoping** — Per PR and head.
6. **State over time** — The line changes when the card lands.
7. **Who wrote it** — n/a.
