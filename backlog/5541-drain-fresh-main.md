---
bornAs: xs1hdl7
kind: story
size: 5
status: open
relatedTo: ["5540", "5407", "2692", "2740"]
scope: ["we:scripts/lib/merge-freshness.mjs", "we:scripts/lib/merge-queue.mjs", "we:scripts/lib/__tests__/merge-queue.replay.test.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-08"
tags: [merge-queue, integration-authority, drain]
---

# Merge queue: the drain merges the queue head only on a fresh green against current main

Ready PRs form one ordered queue (ruled priority class, then in-class score). The drain acts on the head only and merges it only when its required checks passed on its current head, on a base at the current main tip (or main moved only on files it doesn't touch, a setting), within a max age. A stale head is refreshed once through the existing rebase-onto-main path, then waited on. Batch size 1. Off by default. The drain stays the single writer. Replay fixtures: #4361 and the 2026-10-08 red-main window.

Operator "Ok", 2026-10-08 (held item 158), widened the same day to a real merge queue defined as the Integration
Authority protocol of the delivery standard (epic 5407; protocol text card 5540). Incident: the 2026-10-08
red-main incident review in the workspace operations metrics ("Still missing" item 1).

## Replay fixtures (real 2026-10-08 data)

**#4361.** Head `a5938d89`, base `52c4af9c`, main tip at merge `26b439b7` (125 commits past the base, one of
them touching a file #4361 changed). `test` passed 15:14:24Z, merged 16:57:05Z (pass 103 min old). Main red from
17:04Z for 6 h 41 min. With the rule on: `refresh` (`base-behind-main`, `pass-too-old`), in both strict and
disjoint mode.

**The window: 60 PRs merged 16:00Z..23:59Z.**

| Setting | Merge unchanged | Needs refresh |
|---|---|---|
| Off (today) | 60 | 0 |
| On, strict base | 3 | 57 |
| On, disjoint main moves + 30 min | 45 | 15 (incl. #4361) |

Finding: strict mode with batch size 1 serialises every merge behind one CI run (about 10 to 15 min), so it caps
throughput near 4 to 6 merges an hour against today's ~8. Disjoint mode keeps most of today's flow and still
catches #4361. Batching (a later policy; decision 2692's batching rider, tripwire 2740) is what restores throughput for strict mode.

## Design

Pure rules, facts in, verdict out, no forge or label strings:

- `we:scripts/lib/merge-freshness.mjs` — `assessMergeFreshness({ pr, main, nowMs, settings })` →
  `{ fresh, reasons }`. Reasons: `pass-not-on-head`, `base-behind-main`, `pass-too-old`, `facts-incomplete`
  (fail closed), `rule-off`.
- `we:scripts/lib/merge-queue.mjs` — `orderQueue(entries, settings)`, `planQueue({ queue, main, nowMs,
  refreshed, queueSettings, freshnessSettings })` → per PR `merge` | `refresh` | `wait` | `refuse` | `queued`,
  and `validateQueueSettings`.

Settings (off = today; with both off the plan is every PR `merge` in today's order):

```js
MERGE_FRESHNESS_DEFAULTS = { enabled: false, maxAgeMinutes: 30, allowDisjointMainMoves: false }
MERGE_QUEUE_DEFAULTS = { enabled: false, batchSize: 1, classOrder: ['main-fix', 'normal'],
  defaultClass: 'normal', strategy: 'drain-direct' }
```

Priority / incident mode: a `main-fix` class PR goes to the head of the queue but still needs a fresh run.

Reserved, not built (settings refuse them): `batchSize > 1` (test N together, split on failure) and
`strategy: 'forge-native-queue'` (a GitHub-native merge queue adapter; operator: "eventually might be an option").

### Hook into the drain (PENDING: `we:scripts/merge-ai-prs.mjs` is held by #4453 and #4446)

One call, right before the existing
`mergePr({ pr: c.num, repo: c.repo, method: 'merge', matchHeadCommit: traceHeadSha, caller: 'drain' })`
(inside the serial-writer mutex, after every existing gate). IO builds the facts (head, merge-base, files with a
capped flag, required-check state and time, main tip and files since the base, class from the main-fix marker);
`planQueue` returns the action; `merge` proceeds unchanged; `refresh` calls `refreshOntoMain(laneRef)` from
`we:scripts/conveyor/ci-red-recovery-watch.mjs`, records the head, and logs `merge-queue: refresh PR #N (<reasons>)`;
`wait` / `refuse` / `queued` skip with a log line. It only adds a requirement: no existing guard is loosened.

## Done when

1. **Executable** — `npm run test:unit -- <the replay test>` (we:scripts/lib/__tests__/merge-queue.replay.test.mjs) fails before and passes after: #4361 → refresh;
   window counts 60 / 3 / 45; order; head-only; refresh once per head then wait; P0 first but still fresh;
   incomplete facts refuse; batching and forge-native strategy refused.
2. **Live (after the hook lands)** — with the overlay loaded on the drain clone and the settings on, the drain log
   shows the next stale ready PR refreshed before merge (`merge-queue: refresh PR #N`), and a fresh one merges
   unchanged.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are SHAs, paths, times and ruled class names; no label or comment text.
2. **Truncated reads** — a capped file list or cut-off main read → `facts-incomplete` → `refuse`, never "disjoint".
3. **Shared state files** — the per-head refresh record is written by the drain inside its serial-writer mutex.
4. **Fail closed** — any missing fact (pass time, base, tip) → `refuse`; the PR is not merged.
5. **Identity scoping** — the refresh record is keyed by PR key + head SHA, so a new push resets it.
6. **State over time** — each merge moves main; the next head is re-judged on the new tip; `matchHeadCommit` pins the merge.
7. **Who wrote it** — n/a: the rules read CI results and git history, not author-written text.
