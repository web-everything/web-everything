---
bornAs: x4qfbpf
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/backlog.mjs", "we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-06"
preparedAgainstSha: "75c39659a06fefd7ee76fb1af223d53880109a25"
tags: []
---

# Legacy hash repair transition before the backlog-ids check goes live

From #3732: hashes already on main are repaired by number-stranded. The repair PR cannot pass today's gates, since the stranded-hash rule sees the originals and the hand-numbered rule rejects the new NNNs. The build validates the resulting tree and the exact hash-to-NNN mapping, never an unrelated-addition exemption. Blocks activating the backlog-ids required check.

## Done when

1. **Executable** — a test seeds a main with stranded hash cards, runs the repair, and asserts the resulting tree matches the exact hash-to-NNN mapping with every reference rewritten. No unrelated-addition exemption is used.
2. **Executable** — the repair PR passes the stranded-hash and hand-numbered gates through the validated mapping, not a blanket exemption. Fails before this lands.
3. This card blocks activating the `backlog-ids` required check.

## Progress

- 2026-10-06 prepare pass. Premise check against `origin/main` `75c39659a`: `git log` for `4986`/`4986` shows only the drain's numbering commit `2efe1dc3b`; no repair transition exists. `backlog/` currently holds zero hash-named files, so the repair is not yet needed on main, but the card blocks activating `backlog-ids` (#4989 `blockedBy` 4986), so the transition must exist before activation. Premise holds. Size unchanged. Scope widened by `we:scripts/check-standards.mjs` (the gate call sites at :774/:782 must be wired; review finding). `we:scripts/backlog.mjs` stays in scope for the proof run only.

## Design

Today a repair PR that renames stranded `x…` cards to NNNs fails two gates from opposite sides. `strandedHashesOnMain` (`we:scripts/check-standards-rules.mjs:2870`, wired at `we:scripts/check-standards.mjs:774`) reads origin/main and errors on every hash file there, including ones the PR deletes. `handNumberedNewItems` (`we:scripts/check-standards-rules.mjs:2919`, wired at `we:scripts/check-standards.mjs:782`) errors on every NNN in the tree that is not on origin/main, which is exactly what the repair adds. `number-stranded` (`we:scripts/backlog.mjs:1261`) refuses in a lane, and its engine `numberPendingHashes` (`we:scripts/lane-drain.mjs:680`) rewrites every reference in one commit, so the repair PR is made by the drain/primary and opened as a PR from that commit.

Mechanism: a pure function `validateLegacyHashRepair({ baseBacklogPaths, headItems, readBornAs })` in `we:scripts/check-standards-rules.mjs` that proves a PR is a legacy repair. It derives the mapping from the tree itself: each hash file on base that the head deletes must reappear as exactly one NNN file whose `bornAs` equals that hash, and NNNs must be the contiguous `max(base NNN)+1…` run in the same topological (blockedBy) order `numberPendingHashes` uses. Anything else (an extra new NNN, a gap, a wrong `bornAs`, a hash file left behind that is not renumbered, a card changed beyond rename plus reference rewrite) returns named errors. The result is a validated mapping, never a boolean exemption.

Wiring in `we:scripts/check-standards.mjs`: when the validator returns a clean mapping, `strandedHashesOnMain` is given the mapped hashes as already-repaired and `handNumberedNewItems` is given the mapped NNNs as expected. Both gates stay fully active for every card outside the mapping. A PR that is not a repair gets an empty mapping, so behaviour for ordinary PRs is unchanged.

## MVP

Musts:
1. `validateLegacyHashRepair` in `we:scripts/check-standards-rules.mjs` with the exact-mapping rules above.
2. Both gates accept only the validated mapping's hashes and NNNs, wired at `we:scripts/check-standards.mjs` (the two gate call sites named in Design).
3. Tests (see Test plan) including the seeded-main end-to-end repair.
Out of scope (Follow-ups): a dedicated `repair-legacy-hashes` verb, activation of the `backlog-ids` check (#4989), any change to `numberPendingHashes` allocation (#4987).

## Test plan

In `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` (existing file) plus one new `we:scripts/__tests__/legacy-hash-repair.test.mjs`:
- Seeded repo: throwaway git repo whose main has three stranded hash cards with `blockedBy`/`parent`/body references; run `numberPendingHashes` in it; assert the resulting tree equals the exact expected hash→NNN map and zero hash refs remain. Fails RED before: no validator/expected-mapping assertion exists and the gates reject the tree.
- Gate acceptance: with the validated mapping, `strandedHashesOnMain` and `handNumberedNewItems` return no errors for the repair tree. RED before: both error.
- Exactness: an extra hand-picked NNN beside a valid repair, a skipped number (gap), a wrong `bornAs`, a left-behind hash, and a wrong order each yield a named error. RED before: no function to reject them, and a blanket exemption would pass them.
- Non-repair PR: an ordinary PR adding a hand-picked NNN still errors in `handNumberedNewItems` (no regression).

## Proof plan

Live: build a scratch clone of current `origin/main`, plant three hash cards, run `node we:scripts/backlog.mjs number-stranded` in the scratch primary-shaped checkout, and run `npm run check:standards` on the result. Record before (both gates red, on the unmodified rules) and after (green with the mapping, red when one NNN is altered by hand) in the PR body.

## Follow-ups

- `repair-legacy-hashes` verb that produces the repair PR end to end (new item).
- Operator activation of the `backlog-ids` required check once the repair has landed (#4989 setup step).

## Review resolutions (adversarial pass, 2026-10-06)

- **Mapping rule made precise.** The validator must reproduce `numberPendingHashes` exactly: pending stems sorted on the full stem (`[...pending].sort()`), blockers parsed from frontmatter (flow and block YAML), only blockers that are themselves pending count, cycle fallback takes the first remaining item. Reuse the allocator's own ordering helper rather than re-deriving it, so the two cannot drift.
- **Partial repair.** Cards the drain deliberately holds for citations outside the rewrite scope (`we:scripts/lane-drain.mjs` ~905-928) stay hash-named. A repair that leaves a hash file is accepted only if that hash is in the allocator's own held set; any other leftover is an error.
- **Dropped:** "a card changed beyond rename plus reference rewrite" — gold plating; not in Done-when.
- **Test plan corrections.** The seeded `numberPendingHashes` case is a characterization that already passes; only the validator and gate-acceptance assertions are RED before. The non-repair-PR case is a regression guard, not RED. The "wrong order" case uses a fixture whose blockedBy order differs from sorted order. One runner-level test runs `we:scripts/check-standards.mjs` on the repaired tree, covering Done-when #2.
- **Proof plan corrections.** Run the scratch clone outside `.lanes/`, outside `GITHUB_ACTIONS`, with the planted hash commits backdated past `STRANDED_HASH_GRACE_SECONDS`; otherwise the stranded gate is only a warning and "before: red" cannot be shown. `WE_SKIP_HAND_NUMBERED_GATE` is not used on the repair path.
