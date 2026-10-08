---
bornAs: xm1mi56
kind: story
size: 5
parent: "5467"
status: open
relatedTo: ["5468", "3363", "3024"]
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/review-loop-policy.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/lib/jury-core.mjs"]
dateOpened: "2026-10-08"
tags: [review, ledger]
---

# Stable finding identity in the ledger + scoped re-review in shadow

Fixer/review proposal, operator 2026-10-08, P3 prerequisite (proposal "First slices" item 3, B1 part 1). Today every round re-reads the full `base..head` diff in we:scripts/operations/review-pr.mjs, and the ledger keeps no finding identity (we:scripts/lib/review-loop-policy.mjs says so). So round N+1 samples new findings on code round N already saw (`later-round-find` 9 → 29). This slice records a stable finding identity and runs the delta-scoped re-review in SHADOW only: the live verdict is unchanged, and a journal records what the scoped review would have decided.

Builds on #3363 (reviewer identity per round) and #3024. The scope rule is expressed through the protocol card 5468's shape.

## Acceptance

- [A1] **Executable** — a replay test feeds the 2026-10-08 window's recorded rounds and asserts each round-2+ finding gets the same identity as its round-N twin when file, symbol and defect class match.
- [A2] Each ledger finding carries an identity (file + symbol + defect class) and a status: raised, tolerated, fixed or carded.
- [A3] The review-scope rule is a pure function: round N+1's scope = the diff since the last reviewed head + send-back findings + the card's `## Acceptance` list (#5399).
- [A4] In shadow, each round-2+ review journals "would have blocked" vs "would have carded" per finding; the live verdict is unchanged.
- [A5] **Proof** — replaying the 2026-10-08 window journals which round-2+ blocks would turn into cards (the proposal estimates 10 of 26 rounds), giving the numbers for P3's flip.
- [A6] Shadow on/off is a declared setting; off = today's full re-review with no journal.

## Non-goals

- [N1] No live change to any verdict: binding the prior round is 5470 (P3).
- [N2] No Plateau cross-round findings view (later, in Plateau).
- [N3] No change to round 1: it stays a full review.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — finding text is data; identity uses only file, symbol and class fields, never free text.
2. **Truncated reads** — a missing prior-round record means "no identity match": the finding is treated as new.
3. **Shared state files** — ledger rows are appended through the existing ledger writer; the shadow journal is a separate append-only file.
4. **Fail closed** — a failed identity match or unreadable ledger leaves the full review in force (today's behaviour).
5. **Identity scoping** — identities are scoped per repo and PR; a rename of the symbol is a new identity.
6. **State over time** — "last reviewed head" is read from the ledger, not from the clock.
7. **Who wrote it** — finding status is set only by ledger writes from the review and fix roles, never from PR comments.
