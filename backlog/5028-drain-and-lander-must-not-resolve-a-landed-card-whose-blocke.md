---
bornAs: xnaqr9r
kind: story
size: 3
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/backlog-stranded-sweep.mjs", "we:scripts/__tests__/lane-drain.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Drain and lander must not resolve a landed card whose blockedBy are still open

Live on #3834 (card 4374): landing the PR resolved a card whose blockers were still open, because we:scripts/lane-drain.mjs resolveLandedItem (shared with we:scripts/merge-ai-prs.mjs) and we:scripts/backlog.mjs resolve never check the card's blockedBy. Fix: refuse or skip the resolve flip when any blockedBy is unresolved, keep the card open, and report it.

## Scope

- we:scripts/lane-drain.mjs `resolveLandedItem` (the one resolve-on-land home, also called by we:scripts/merge-ai-prs.mjs): before running `we:scripts/backlog.mjs resolve`, read the card's `blockedBy` and look each blocker up; if any is not `resolved`, skip the flip, leave the card `open`, and return `{ flipped: false, blockedBy: [...], reason: 'blockers-open' }`.
- Both callers (the drain and the label lander) print the skip plainly ("card N stays open, blocked by M, K") instead of the success line, and the stranded-sweep (we:scripts/backlog-stranded-sweep.mjs) honours the same check since it resolves through the same function.
- Operator ruling: PR #3834 lands as is; this card is the real fix. The check lives in the drain/lander, not in `we:scripts/backlog.mjs resolve` itself (a human `/resolve` stays allowed).
- Out of scope: auto-resolving the card later when its last blocker resolves (a follow-up if wanted).

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/lane-drain.test.mjs` includes a regression for the #3834 / card 4374 shape (a landed card with an open blocker) and fails before the fix, passes after.
2. **Must (refuse)** — a landed card with at least one non-resolved `blockedBy` is NOT flipped to resolved by the drain or the label lander; it stays `open`, no resolve commit is made, and the skip names the open blockers in the drain output.
3. **Must (unreadable blocker)** — a blocker that cannot be found or read counts as open (never as resolved): an unknown blocker never lets the flip through.
4. **Must (no regression)** — a landed card with no `blockedBy`, or with every blocker `resolved`, is still resolved on land exactly as before, for the drain and the label lander alike.
5. **Must (non-source inputs)** — the check reads frontmatter only, so it behaves the same for docs-only, config-only and data-only cards.
