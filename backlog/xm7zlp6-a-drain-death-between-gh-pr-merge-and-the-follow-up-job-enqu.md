---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/backlog-stranded-sweep.mjs", "we:scripts/lib/pr-merge-gate.mjs", "we:scripts/conveyor/orphan-claim-release.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A drain death between 'gh pr merge' and the follow-up job enqueue loses resolve-on-land for good; the only ba…

Flow-sim gap R8a-G1, class K3 (one-shot step, no re-driver). Failing input: WE PR #P (head lane/4459-foo, carries item 4459, status:active card) is approved and in the cascade. Default merge method (--merge). gh pr merge succeeds, then the drain process dies (kill, OOM, host sleep) before line 7453 enqueues the drain-followup job. On restart the PR is MERGED, so it is not a candidate and never re-enter… Cited: we:scripts/merge-ai-prs.mjs:7153, we:scripts/merge-ai-prs.mjs:7453-7455, we:scripts/merge-ai-prs.mjs:7635, we:scripts/backlog-stranded-sweep.mjs:209-215, we:scripts/lib/pr-merge-gate.mjs:15-23. Soak-break sketch: Fixture: merged PR (state MERGED, headRef lane/4459-foo, merge commit subject 'Merge pull request #7000 from x/lane/4459-foo'), we:backlog/4459-foo.md status:active, no queue state, no job record. Action: run one drain pass + autoStrandedSweepPass(apply:true)…

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
