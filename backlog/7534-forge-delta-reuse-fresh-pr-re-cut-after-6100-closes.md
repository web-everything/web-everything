---
bornAs: xzo459u
kind: task
parent: "7533"
status: open
scope: ["we:scripts/readiness/remote-exec.mjs", "we:scripts/readiness/forge-exec-manifest.mjs", "we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs", "we:scripts/readiness/__tests__/remote-exec.test.mjs"]
dateOpened: "2026-10-31"
preparedDate: "2026-10-31"
preparedAgainstSha: "2ee4dcbf9bf17c1674e7948339d0b15c164151b6"
tags: []
---

# Forge delta-reuse: fresh PR re-cut after #6100 closes

After PR #6100 closes and card 7533 lands, re-cut the delta-reuse change on the merged tip. It must read projected memory leaves via sourcePath and pass the parity matrix in we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs (15 rows, 16 once PR #6126 amends card 7533).

## Progress

- 2026-10-31 — premise check against `origin/main` 2ee4dcbf9b and PR #6059 head 4186445120
  (`lane/forge-remote-exec-s2`, merge base = main tip, 21 commits ahead).
  - **Old premise:** "re-cut" PR #6100's git delta manifest onto the merged #6059 tip.
  - **Corrected premise:** the delta manifest code itself is already on main. PR #6101 (stacked on #6100) merged
    to main and carried it; `git rev-list --left-right --count origin/main...origin/lane/forge-fast-manifest` is
    `48 1`, and the one commit main lacks is a CI-only retry (5d680cea8d). So nothing from #6100 needs to be
    replayed. What is really left is the gap #6059 adds on top: after a delta build, #6059 throws
    `Projected memory inputs require full ship` whenever any manifest entry has a `sourcePath`
    (we:scripts/readiness/remote-exec.mjs:499 on #6059). Every WE checkout has the `.claude/agent-memory` bridge,
    so buildManifest always adds projected leaves (we:scripts/readiness/remote-exec.mjs:334-336 on #6059).
    Result: once #6059 lands, the delta path never runs on a real lane. This card makes the delta path handle
    projected leaves so it can be used, and keeps 7533's checks unchanged.
  - Not delivered: no commit on main or #6059 references 7534/xzo459u, and the refusal is still on #6059 head.
  - **Scope corrected:** added we:scripts/readiness/remote-exec.mjs (the refusal, `digestDeltaInput` and the delta
    byte count live there, not in we:scripts/readiness/forge-exec-manifest.mjs) and
    we:scripts/readiness/__tests__/remote-exec.test.mjs (existing memory-bridge fixtures at :613-615 and :668-682
    on #6059). The goal is unchanged.
  - Overlap: card 7542 (xz5f6n4, PR #6125, daemon heavy runs to Forge) and card 7515 also edit
    we:scripts/readiness/remote-exec.mjs. No shared function: 7542 touches admission and the allowlist; 7515
    builds on this card's result.
  - Adversarial review (2026-10-31): dropped a planned extra bridge check (buildManifest already does it at :227),
    so T4 is now a regression guard with a positive control. The digest source-path lookup became a defensive
    missing-blob guard, because with today's bases projected leaves are always shipped. Fixed the T5 row-12
    wording.

## Design

All line numbers are on PR #6059 head 4186445120. They will move once 7533 lands, so the builder re-finds each
spot by name.

1. **Drop the blanket refusal.** Remove the `sourcePath` throw after `buildManifest` in `buildDeltaManifest`
   (we:scripts/readiness/remote-exec.mjs:499). Projected entries keep `tracked:false`, `sourcePath` and
   `memoryOid` exactly as buildManifest makes them (:334-336). Their sha256 is the source file's sha256, because
   buildManifest copies the hashed source entry.
2. **The bridge check needs no new code.** `buildManifest` already calls `verifyMemoryLink` whenever the bridge is
   tracked (:225-228), and `buildDeltaManifest` always calls `buildManifest` (:498). So the bridge is checked on
   every delta build. Staging checks it again for each copied leaf (:704). The build keeps both checks as they are.
3. **Read every leaf through its source path (hygiene and a defensive guard).** Use `entry.sourcePath ?? entry.path`:
   - in the `deltaBytes` lstat (:507). Today it works, but only by following the client symlink through
     `.claude/agent-memory`, against the "never follow a client link" rule (:167-168);
   - in `digestDeltaInput` (:528). For an unchanged leaf, look up `delta.baseBlobs` by its source path. A missing
     blob throws `Base blob unavailable; use full ship`, never a TypeError on `blob.oid`. With today's bases this
     branch is not reached for projected leaves, because they are always in `deltaPaths` (step 4). The guard
     matters once the warm-base Follow-up lands, and for any unchanged entry whose blob is missing.
   The `reuse` lookup in buildManifest (:309) needs no change: it runs on the source path, and projections are
   copied from the source entry after the loop (:334), so they inherit the reused hash.
4. **The base side is unchanged.** Warm bases come from `git ls-tree` and hold only regular tracked blobs, so the
   symlink and its projections are never in a base (we:scripts/readiness/forge-warm-base.mjs:214-228). So every
   projected leaf counts as new against the base and is shipped in `deltaPaths`. That is correct, and still far
   cheaper than a full ship. Reusing them from the base is a Follow-up.
5. **7533's checks are unchanged.** All git calls stay behind 7533's `bindGit`. The filesystem walk still runs
   after this manifest is built, and check (b) (bridge valid, every `agent-memory-src` file projected) applies to
   delta exactly as to full scan. This card adds no git call and no exception to the walk.
6. **Shipping and the remote check are unchanged.** Staging already reads `sourcePath` (:705-711) and re-hashes
   each staged leaf (:735-737). On Forge, `verifyManifest` re-checks the assembled tree
   (we:scripts/readiness/forge-exec-run.mjs:867).

## MVP

- Step 1 (drop the refusal) is the fix. Step 3 is two one-line changes: the source-path lstat, and the
  missing-blob guard that turns a TypeError into a clean full-ship refusal.
- Add a "bridge present" axis to 7533's parity matrix. Every row except 12 (which turns the bridge into a
  directory) runs with a valid bridge. Rows 10 (201-char we:MEMORY.md line) and 12 must still fall back.
- OUT: putting projected leaves into warm bases (Follow-ups); any change to the base manifest wire format; any
  change to we:scripts/readiness/forge-exec-run.mjs.

## Test plan

Red first on the 7533 tip (with the refusal still in place), green after:

- **T1 delta used with a bridge present** (we:scripts/readiness/__tests__/remote-exec.test.mjs, beside the bridge
  fixture at :668): a clean lane with the bridge and one edited source file gives `manifestMode:'git-delta'`.
  `deltaPaths` holds the edited file plus every `.claude/agent-memory/*` leaf. RED today: the refusal throws, so
  the mode is full-scan.
- **T2 digest parity with projection** (unit): for the T1 tree, `digestDeltaInput` equals the full-ship
  `digestInput` of the same tree. RED today only through T1 (no delta is ever built with a bridge).
- **T3 missing blob is a clean refusal** (unit on `digestDeltaInput`, direct input): an unchanged entry whose
  blob is absent from `baseBlobs`, once with a plain path and once with a `sourcePath`. Expect a throw with
  `use full ship` text. RED today: a TypeError on `undefined.oid` (:528).
- **T4 bad bridge under delta (regression guard):** the bridge target changed to `../private`, or a wrong
  `memoryOid`. The delta build throws `Unverified memory bridge` and the run ships full scan, then local fallback.
  This passes today and must still pass after the refusal is dropped. Positive control: stub out the
  `verifyMemoryLink` call at :227 and T4 turns red.
- **T5 parity matrix with projection:** each row of
  we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs (15 rows, 16 after #6126) runs with a valid
  bridge, except row 12, which replaces it. Delta and oracle agree on entries and sha256, or both refuse. Rows 10
  and 12 still refuse.
- **T6 no symlink is followed:** count the lstat calls on `.claude/agent-memory/*` paths in the delta byte count.
  Expect zero; all of them go through `agent-memory-src/*`.

## Proof plan

- Mutation proof: putting the refusal back turns T1/T2/T5 red. Removing the missing-blob guard turns T3 red.
  Removing `sourcePath ??` from deltaBytes turns T6 red. Stubbing the bridge check in buildManifest (:227) turns
  T4 red.
- Live: from a real lane clone with a warm base on Forge, run the parity test through
  we:scripts/readiness/remote-exec.mjs (`npx vitest run` on we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs)
  before and after. Before, stderr shows `manifest: full-scan (Projected memory inputs require full ship)`. After,
  it shows `manifest: git-delta (N changed of M)`, and the telemetry rsync record shows `shipMode:'delta'` with
  `deltaFileCount` about equal to the memory corpus (~320 files) plus the edits. The receipt verifies, and the exit
  code matches a local run.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no new text reaches a shell, argv, path or regex; paths stay Buffers from buildManifest.
2. **Truncated reads** — a missing or short base blob for a source path throws `use full ship` (T3); no partial digest.
3. **Shared state files** — n/a: no state file is written; the memory corpus is only read.
4. **Fail closed** — bridge check failure, missing source blob, or a walk mismatch from 7533 each fall back to full scan, and from there to the existing local fallback; never `not-started` and never a silent skip (T3, T4).
5. **Identity scoping** — a projected leaf is keyed to its source path in the same bound worktree (7533 `realpath(toplevel)===realpath(cwd)`); the bridge oid must match the committed link (T4).
6. **State over time** — a source edited between the stat capture and staging is caught by staging's re-hash (:735-737); no state carries across runs.
7. **Who wrote it** — n/a: no authorship signal; trust comes from the git blob oid and the sha256.

## Follow-ups

- Put projected memory leaves into warm bases (we:scripts/readiness/forge-warm-base.mjs publishes
  `.claude/agent-memory/*` as copies of `agent-memory-src/*`), so unchanged memory files are not re-shipped on
  every delta.
- Close PR #6100 with a pointer to this card and the `48 1` evidence (an operator/judge action, not a build step).

## Proposed blockedBy changes

- (land-after, not an edge) PR #6059 has no backlog card, so it cannot be a `blockedBy` target. Build only after it
  merges.
- add 7533 — this card changes code 7533 rewrites (bindGit and the walk check in
  we:scripts/readiness/remote-exec.mjs) and extends its parity test
  (we:backlog/7533-forge-remote-exec-bind-git-to-cwd-and-verify-manifest-agains.md:33).

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs` passes every row with the memory bridge present, including projected leaves read via sourcePath. It fails on the 7533 tip while the `Projected memory inputs require full ship` refusal remains.
- [A2] **Executable** — `npx vitest run we:scripts/readiness/__tests__/remote-exec.test.mjs -t "projected memory"` (T1-T4, T6) fails before (T1/T2: delta refused; T3: TypeError on a missing blob; T6: lstat through the symlink) and passes after. T4 is a regression guard with the positive control in the Test plan.
- [A3] **Executable** — the fail-closed paths: a bad bridge and a missing source blob each produce a full-scan manifest reason, never a TypeError or `not-started` (T3, T4 in the same run).

## Non-goals

- [N1] Does not start before PR 6059 lands and card 7533 has landed. Does not change warm-base construction or the Forge runner.
