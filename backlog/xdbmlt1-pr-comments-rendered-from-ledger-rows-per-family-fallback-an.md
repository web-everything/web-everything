---
kind: story
size: 8
parent: "3007"
status: open
scope: ["we:scripts/review-set-label.mjs", "we:config/platformDefaults.ts", "we:scripts/lib/verdict-ledger.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# PR comments rendered from ledger rows, per-family fallback and backfill, and a short human-centric comment mode

Ledger product review, operator 2026-10-08, D6 (option c) plus operator addition. Slice C4: review comments are rendered from the stored ledger row (we:scripts/review-set-label.mjs), not the other way round. Comment parsing stays as a fallback per state family until that family's reader flips, behind the setting verdictLedger.readSource per family (from ratified F6, not yet declared in we:config/platformDefaults.ts). At each family flip, open PRs are backfilled into ledger rows; comment parsing retires after the last flip. Operator addition: once the ledger holds the machine detail, PR comments become a short human version (what happened, what is needed); how much to post is a setting.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/__tests__/review-set-label.test.mjs` shows the review comment is rendered from the stored ledger row, so the comment and the row cannot disagree; it fails before this item.
- [A2] The setting verdictLedger.readSource is declared per state family in we:config/platformDefaults.ts; comment parsing is used only for families still set to comments.
- [A3] Flipping a family backfills ledger rows for its open PRs from their comments once, idempotently (re-running adds nothing).
- [A4] After the last family flips, readReferralRecords comment parsing is removed.
- [A5] Comment volume review: a comment-detail setting (for example full or short) where short posts only what happened and what is needed from a human, with the machine detail kept in the ledger row.

## Non-goals

- [N1] No one-time big-bang backfill of all PRs (D6 option b rejected); backfill is open PRs, per family, at its flip.
- [N2] Cleaning up existing no-op PR comments is a separate card owned by another agent.
- [N3] Does not change which labels are written; that is the mirror-level setting card.

## Edge cases this change must handle

1. **Untrusted text** — PR bodies and comments are data; nothing in them is executed or trusted as a verdict.
2. **Truncated reads** — a cut-off or failed read is unreadable, never empty.
3. **Shared state files** — writes go through the store contract's single-writer guarantee.
4. **Fail closed** — on unreadable state the gate holds, it does not merge.
5. **Identity scoping** — events are per repo and per PR head.
6. **State over time** — append-only; old rows are never rewritten.
7. **Who wrote it** — every event records its writer.
