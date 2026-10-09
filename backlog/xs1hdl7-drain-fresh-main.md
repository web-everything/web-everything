---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/merge-freshness.mjs", "we:scripts/lib/merge-freshness.test.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Drain merges only on a pass fresh against current main

Before the drain merges a PR, require its required checks to have passed on a head based on the current main tip (or main moved only by commits not touching the PR's files, a setting) and younger than a max-age setting; otherwise refresh once per head via the sanctioned rebase-onto-main path and wait. Off by default. Replay fixture: #4361 merged on a 2 h old pass and turned main red (2026-10-08). P0/main-fix PRs still need a fresh run but go first. GitHub merge queue recorded as a possible future merge-strategy policy, not built.

Operator "Ok", 2026-10-08 (held item 158). Incident:
the 2026-10-08 red-main incident review in the workspace operations metrics ("Still missing" item 1).

## Replay fixture: PR #4361

| Fact | Value |
|---|---|
| Head | `a5938d8938a20137e76d2145e49d40ee8fff4970` |
| Head's base (merge-base with main) | `52c4af9c3a22fffe2a01965240bba0f1d328e00e` |
| Main tip when merged | `26b439b79ec7a5b8b289c6fde54e8abc64a639d0` (125 commits past the base) |
| Required `test` passed | 2026-10-08T15:14:24Z |
| Merged | 2026-10-08T16:57:05Z (pass was 1 h 43 min old) |
| Result | Main red from 17:04Z for 6 h 41 min |

With the rule on (`maxAgeMinutes: 30`), the verdict at 16:57Z is `refresh` for both reasons (`base-behind-main`, `pass-too-old`), not `merge`.

## Design

### Pure rule: `we:scripts/lib/merge-freshness.mjs`

`assessMergeFreshness({ pr, mainTip, mainCommitsSinceBase, nowMs, settings, refreshLedger })` returns
`{ verdict: 'merge' | 'refresh' | 'wait' | 'refuse', reasons: string[] }`. No IO, no clock, no gh.

- `pr`: `{ num, headSha, baseSha (merge-base of head and main), files, requiredPassAt, priority }`.
- `mainCommitsSinceBase`: `[{ sha, files }]`, main commits after `baseSha` up to `mainTip`.
- `refreshLedger`: heads already refreshed (`{ [num]: headSha }`), so a refresh happens once per head.

Merge-fresh only if BOTH hold:
1. **Base is current.** `baseSha === mainTip`, or (setting `allowDisjointMainMoves`) every commit in
   `mainCommitsSinceBase` touches no file in `pr.files`.
2. **Pass is young.** `nowMs - requiredPassAt <= maxAgeMinutes`.

Otherwise: `refresh` if this head is not yet in the ledger; `wait` if it was refreshed and the new run is pending.
`refuse` (fail closed) when an input is missing or truncated (no pass time, unreadable file list, commit list cut off).

### Settings (declared, today's behaviour = off)

```js
export const MERGE_FRESHNESS_DEFAULTS = Object.freeze({
  enabled: false,              // off = today's behaviour, byte-identical
  maxAgeMinutes: 30,
  allowDisjointMainMoves: false, // true = main moving only on files the PR doesn't touch still counts as current
  priorityLabels: ['priority:p0', 'main-fix'],
  mergeStrategy: 'drain-direct', // the only value built; see "Future policy"
});
```

### Wiring (one hook in `we:scripts/merge-ai-prs.mjs`)

Right before the `mergePr({ ..., matchHeadCommit: traceHeadSha, caller: 'drain' })` call (inside the serial-writer
mutex, after every existing gate), call the IO wrapper. `merge` proceeds unchanged. `refresh` calls the existing
sanctioned path `refreshOntoMain(laneRef)` from `we:scripts/conveyor/ci-red-recovery-watch.mjs`
(`rebaseDropManifest`, gh calls via `gh-throttle`), records the head in the ledger, logs
`freshness: refresh PR #N (<reasons>)` to the drain log, and skips the PR this pass. `wait`/`refuse` skip with a
log line. This only ADDS a requirement: no existing merge-gate guard is loosened or bypassed.

### Priority / incident mode

PRs carrying a `priorityLabels` label (P0 main-fix) are NOT exempt from the fresh run. They sort first among
refresh candidates and among merges, so the fix-main PR is refreshed and merged ahead of the queue.

### Future policy (recorded, not built)

A GitHub-native merge queue is a possible future `mergeStrategy` value (`'github-merge-queue'`): an adapter that
enqueues instead of calling `mergePr`, letting GitHub run CI on the merged result. Operator: "eventually might be
an option." Not built here; the setting reserves the name.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/merge-freshness.test.mjs` (run from the repo root, without the `we:` prefix) fails before and passes after.
   Cases: #4361 replay → `refresh` (`base-behind-main`, `pass-too-old`); fresh PR → `merge`; disabled → `merge`
   always; disjoint main moves with setting on → `merge`, off → `refresh`; second sight of a refreshed head →
   `wait`; P0 sorts first but still gets `refresh` when stale; missing pass time → `refuse`.
2. **Live** — with the overlay loaded on the drain clone, the drain log shows the next stale ready PR refreshed
   before merge (`freshness: refresh PR #N`), and a fresh one merges unchanged.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are SHAs, paths, timestamps and labels from gh JSON; labels are matched exactly.
2. **Truncated reads** — a capped file list (gh 100-file cap) or cut-off commit list → `refuse`, never "disjoint".
3. **Shared state files** — the per-head refresh ledger is written inside the drain's serial-writer mutex.
4. **Fail closed** — any missing input (pass time, base SHA, main tip) → `refuse`; the PR is not merged.
5. **Identity scoping** — the ledger is keyed by repo + PR number + head SHA, so a new push resets it.
6. **State over time** — main moving between assess and merge is covered by `matchHeadCommit` plus re-assessing each pass.
7. **Who wrote it** — n/a: the rule reads CI results and git history, not author-written text.
