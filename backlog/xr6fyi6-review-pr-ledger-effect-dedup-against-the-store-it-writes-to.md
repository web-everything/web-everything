---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# review-pr ledger effect: dedup against the store it writes to and treat ledgerWriteMiss as not done

Same defect class PR #5195 fixed in the drain recorders (we:scripts/lib/drain-ledger-facts.mjs, we:scripts/merge-ai-prs.mjs#recordDrainHold). The review-pr LEDGER effect in we:scripts/operations/review-pr-io.mjs (about lines 1330-1352) checks whether its verdict row already exists with a home-only read (foldRepo) and returns success on appended.ok without checking ledgerWriteMiss. A holding verdict (changes/human) that misses the git store spills to home (F4), so on replay the home read says already recorded and git is never retried; the shared ledger keeps the previous verdict, and if that was accepted for the same head the shared readers fail open. Fix: read the store the write lands in (as readDrainLedgerSnapshot does) and treat ledgerWriteMiss as not done.

## Acceptance

- [A1] **Executable** — a test in `we:scripts/operations/__tests__/review-pr-io.test.mjs` runs the LEDGER effect with a dual store whose git append throws, then replays it with git working: before the fix the replay appends nothing to git (home says recorded); after it, the replay appends the verdict to git and the first run reports not done.
- [A2] The first run with a git miss reports the effect as not done (`ledgerWriteMiss` is never success).

## Non-goals

- [N1] Changing the F4 write order itself (holding rows still go home first); this item changes only what the effect reads and how it reads the result.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input; rows are validated by the existing ledger schema.
2. **Truncated reads** — a failed or capped shared read must not count as "no row yet" for a clearing verdict; it refuses and retries next run.
3. **Shared state files** — dedup reads the store the write lands in (git for dual/git), never home alone.
4. **Fail closed** — an unreadable store never reports the verdict as recorded.
5. **Identity scoping** — match rows by repo, PR, head and verdict, as the existing dedup does.
6. **State over time** — a replay after a git outage re-appends exactly once; a duplicate verdict row is harmless.
7. **Who wrote it** — n/a: the writer is the review-pr operation itself, unchanged.
