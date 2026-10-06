---
bornAs: xazahhl
kind: story
size: 3
parent: "4703"
status: open
blockedBy: ["5195"]
scope: ["we:skills-src/file-item/SKILL.md", "we:scripts/operations/card-batch.mjs", "we:scripts/operations/__tests__/card-batch.test.mjs", "we:scripts/lib/card-batch-policy.json", "we:scripts/operations/sweep-orphan-backlog-cards.mjs", "we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Batch new filings through the card batch coordinator (filing delivery kind)

Second #4703 delivery kind, after the prevention MVP is live. Expose admission as a declared card-batch operation so the file-item skill sequence (file-item, then verify, then open-pr; we:scripts/operations/file-item.mjs:32-37) becomes file-item then card-batch admit when the filing kind is enabled, and route the orphan-card sweep the same way. Filing batches stay separate from prevention batches (keyed by repo and kind). Enable filing in the committed policy with the same defaults (10 cards or 120 minutes). A filing that carries any non-card path still takes the ordinary PR path. Queue clearance from file-item (we:scripts/operations/file-item.mjs:97-110) is unchanged and a batched card is never reported as merged before its batch lands.

## Done when

1. **Executable** — `npx vitest run` over we:scripts/operations/__tests__/card-batch.test.mjs and we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs passes (strip the `we:` prefix to execute) with new cases: a filing is admitted to a filing batch keyed separately from prevention; the orphan sweep admits its survivors the same way.
2. **Must (refuse on error)** — a filing whose change set carries any non-card path (docs, config, data, tests, source) or a modified existing card is refused admission and takes the ordinary PR path; an unknown or disabled filing policy does the same.
3. **Must** — file-item queue clearance is unchanged, and no receipt reports a batched card as landed before its batch merges.
4. **Live proof** — at least 3 real filings land in one merged `lane/card-batch-filing-*` PR; record the PR number and members here.
5. **Executable** — `npm run check:standards` green.

## Build checklist

- [ ] Declare `card-batch admit` as an operation; update the three-call sequence in we:skills-src/file-item/SKILL.md.
- [ ] Flip `filing.enabled` to true in we:scripts/lib/card-batch-policy.json only in this slice.
- [ ] Route we:scripts/operations/sweep-orphan-backlog-cards.mjs survivors through admission instead of one PR per survivor.
