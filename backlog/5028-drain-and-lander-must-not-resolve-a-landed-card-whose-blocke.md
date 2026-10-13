---
bornAs: xnaqr9r
kind: story
size: 3
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/backlog-stranded-sweep.mjs", "we:scripts/__tests__/lane-drain.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/backlog-stranded-sweep.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-13"
preparedAgainstSha: "5d0359792f9aa88bb3558a4e667b57dfebcb1068"
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

## Progress

- Premise check (2026-10-13, `origin/main` 5d0359792): not delivered. A `git log -S` search for `blockers-open` over scripts finds nothing, and `resolveLandedItem` (we:scripts/lane-drain.mjs:1414) still has no `blockedBy` read. The only `5028` commits are the JIT-numbering and PR-merge of this card itself.
- Scope: unchanged. we:scripts/merge-ai-prs.mjs and we:scripts/backlog-stranded-sweep.mjs need only report handling, not new logic, because both already call `resolveLandedItem`.

## Design

`resolveLandedItem` (we:scripts/lane-drain.mjs:1414-1441) finds the card via `git ls-files backlog/<num>-*.md` (:1418), reads it (:1421), returns `alreadyResolved` if `status: resolved` (:1422), then shells the `resolve` verb of we:scripts/backlog.mjs (:1423). Insert one check between :1422 and :1423.

1. New exported pure helper `openBlockers(body, readBlockerBody)` in we:scripts/lane-drain.mjs. Extract only the frontmatter block, then parse `blockedBy` with a dedicated block-aware regex, following we:scripts/lane-drain.mjs:829; do not use scalar `readField` for this list field. Accept inline JSON arrays (we:scripts/backlog.mjs:895-902), including trailing comments such as `blockedBy: ["2989"]   # note`, and multi-line `- x` lists. Inspect indented list lines before classifying a bare `blockedBy:` as empty. An absent field, an empty field with no list entries, or `[]` → `[]`. A present value that is not a parseable list (including malformed block entries) → return that raw token as an open blocker: deliberately fail closed. Import `idFromName` and `normalizeId` from we:scripts/backlog/id.mjs and reuse the canonical composition in we:scripts/backlog.mjs:890 (`normalizeId(idFromName(String(ref).trim()) ?? String(ref).trim())`), rather than reimplementing normalization. Validate each token's supported ID or ID-with-slug syntax before canonicalization, then allowlist-test the canonical ID before any lookup. In particular, `"043"` stays `"043"` and looks up `backlog/043-*.md`; `"0043"` stays `"0043"` and looks up `backlog/0043-*.md`. Add an injected `resolveStep` option (default: the shell call) on `resolveLandedItem` so tests can observe "no resolve call" without a full throwaway repo.
2. For each blocker id, resolve its file with `git ls-files` on `backlog/<id>-*.md`, where `<id>` is the NNN or the `x<hash>` spelling (a blocker not yet JIT-numbered still has its hash name). Read it and take `readField(body,'status')`. Only an exact `resolved` counts as closed. No file, unreadable file, no frontmatter, or any other status → the blocker is open.
3. If the open list is non-empty, return `{ flipped: false, alreadyResolved: false, reason: 'blockers-open', blockedBy: [...] }` with no resolve call and no commit. The `resolve` verb in we:scripts/backlog.mjs is untouched (ruling: a human `/resolve` stays allowed).
4. Callers: the drain (we:scripts/lane-drain.mjs:464-467) treats any non-flipped, non-alreadyResolved result as "fall through to the reopen path". Add a branch for `reason === 'blockers-open'` that prints `card N stays open, blocked by M, K`, treats the land as COMPLETE (skips the resolve-reachable gate and reopen-on-fail, continues to finalizeLand: unqueue, lane release, exit 0), and does not count as a resolve failure. The label lander (we:scripts/merge-ai-prs.mjs:6809-6812) routes non-flipped results to `failedResolve` with the "resolve it by hand" warning; give `blockers-open` its own `skippedBlocked` bucket and message, and include it in `resolveOnLandReport`. The stranded sweep (we:scripts/backlog-stranded-sweep.mjs:348-352) copies `flip.reason` into `applied`; also copy `blockedBy`.
5. The blocker lookup uses the same working-tree index as the card lookup, so it sees blockers numbered in the same land pass.

## MVP

Musts only: the helper, the guard in `resolveLandedItem`, the drain's skip message, the lander's own bucket and message, `blockedBy` passthrough in the sweep, and the tests below.

Out of MVP (see Follow-ups): auto-resolving the card when its last blocker resolves; a check inside the `resolve` verb of we:scripts/backlog.mjs; blockers that live in sibling repos.

## Edge cases this change must handle

1. **Untrusted text** — `blockedBy` entries come from card frontmatter. Validate the entire trimmed raw token as an ID or an ID with a safe slug before applying the imported canonical helpers; a valid ID prefix cannot hide an invalid suffix (e.g. `43-../../etc`). Only canonical IDs matching `^(\d+|x[0-9a-z]{6})$` are looked up; rejected raw tokens count as open blockers and are never used in a path or git argv. A slug such as `43-blocker` is accepted, but slugs containing traversal, separators, control characters, quotes, backticks, or invisible/Unicode lookalikes are rejected. The printed skip line folds newlines and backticks via `foldUntrusted` (we:scripts/lib/jury-core.mjs).
2. **Truncated reads** — blocker lookup uses `git ls-files` with an explicit pathspec per id, not a capped listing; a failed or empty read counts as open, never as "no blockers".
3. **Shared state files** — n/a: read-only; the only write is the existing resolve commit, unchanged and still scoped to the one card path.
4. **Fail closed** — unparseable `blockedBy`, missing blocker file, unreadable file, missing `status`, or any status other than `resolved` → open blocker, reason `blockers-open`. An unreadable card body (`body == null`) keeps today's behaviour (out of scope for this card).
5. **Identity scoping** — blocker ids resolve in both spellings (NNN and `xNNNNNN` hash); a hash-named blocker numbered in the same pass resolves via the index. A self-reference in `blockedBy` counts as open (a card cannot unblock itself).
6. **State over time** — the check runs at land time against the current index, so a blocker resolved earlier in the same pass is seen as resolved. A skipped card stays `open`; the stranded sweep is the recovery path and re-runs the same check, so it keeps reporting until the blockers resolve (idempotent).
7. **Who wrote it** — n/a: no comment, label or ref grants trust here; the verdict comes only from the repo's own backlog frontmatter.

## Test plan

In we:scripts/__tests__/lane-drain.test.mjs (pure helper tests plus a throwaway-git-repo case for `resolveLandedItem`, with the resolve step observable so "no resolve commit" is asserted):

- `blocker open → refuses` — the #3834 / card 4374 shape: card `open`, `blockedBy: ["4300"]`, blocker `status: open`. Asserts `flipped:false, reason:'blockers-open', blockedBy:['4300']`, no resolve call, no commit. RED before the fix: the function calls resolve and returns `flipped:true`.
- Red today: `mixed blockers` — one resolved, one open: refuses and names only the open one.
- Red today: `unknown blocker counts as open` — a blocker id with no file, and a blocker file with no frontmatter/status: both refuse.
- Red today: `unreadable blocker refuses` — inject a reader that throws for a valid blocker ID. Assert `reason:'blockers-open'`, the unreadable ID in `blockedBy`, no resolve call, and unchanged commit count in the `resolveLandedItem` integration fixture. Reader errors must never become an empty blocker list.
- Red today: `invalid blocker never reaches lookup` — use lookup spies with newline, CR/U+2028, backtick, quote, leading `--`, path traversal, invisible/Unicode lookalikes, and concatenated invalid tokens, including each invalid shape after a valid `43-` prefix. Assert `reason:'blockers-open'`, zero path/git lookup calls for invalid tokens, no resolve call, and no commit; also use a mixed valid/invalid list to prove only valid IDs reach lookup.
- Red today: `multi-line blockedBy` — frontmatter `blockedBy:\n  - "4300"` with blocker `status: open` refuses, names `4300`, makes no resolve call, and creates no commit. Include single-quoted and unquoted entries, mixed open/resolved entries, a resolved-only block list that permits resolution, and a malformed block entry that refuses without lookup. A similarly named list in body prose must not supply or hide blockers.
- Red today: `unparseable blockedBy` — `blockedBy: nonsense`: refuses.
- Red today: `hash spelling` — an `x…` blocker still `open` refuses (the resolved-allows half is GREEN today, mutation proof: make the helper treat every blocker as open and it fails).
- GREEN today (preservation; mutation proof: make the guard refuse everything and it fails): `no regression` — no `blockedBy`, bare `blockedBy:` with no list entries, `blockedBy: []`, and all blockers `resolved` each still flip and commit, called as the drain calls it (`sync:true`) and as the lander calls it (`sync:false, publish:false`).
- Red today: `non-source card` — a docs-only card with an open blocker refuses identically.
- GREEN today (preservation; mutation proof: move the guard above the already-resolved return and it fails): `already resolved wins` — a card already `resolved` with an open blocker stays `alreadyResolved:true`.
- Red today: lander wiring test in we:scripts/__tests__/merge-ai-prs.test.mjs (`bucketFlip` does not exist yet): a `blockers-open` result lands in `skippedBlocked`, not `failedResolve`, and the message names the blockers. Sweep test in we:scripts/__tests__/backlog-stranded-sweep.test.mjs: the `applied` entry carries `blockedBy`.
- Red today: `trailing comment` — `blockedBy: ["2989"]   # note` names an open blocker and refuses; a resolved blocker permits resolution.
- GREEN today (preservation; mutation proof: strip leading zeros instead of importing the canonical helpers and the exact lookup assertions fail): `padded id / canonical helper` — use a real resolved fixture `we:backlog/043-blocker.md` and `blockedBy: ["043"]`; spy on lookup to assert the exact `backlog/043-*.md` pathspec, then assert resolution is allowed. Also pin `"43"` and `"43-blocker"` to that same fixture via the imported helpers, and `"0043"` to a distinct `we:backlog/0043-blocker.md` fixture.
- Red today: drain caller — a source-scrape assertion that the `blockers-open` branch continues to finalizeLand and bypasses reopen-on-fail (matches the existing scrape style at we:scripts/__tests__/lane-drain.test.mjs:377-409).
- Labels: "blocker open", "mixed", "unknown", "unparseable", "hash spelling (open)", the lander bucket and the sweep `blockedBy` test are RED before the fix; "no regression", "already resolved wins" and "non-source" are guards (green before and after, by design). The lander test calls a small extracted pure `bucketFlip(flip)` rather than scraping source; `skippedBlocked` stays out of the `.failed` check in `queueFollowUpsClean` (we:scripts/merge-ai-prs.mjs:6893) and the sweep reports blocked skips separately from failures.
- GREEN today (preservation; mutation proof: reintroduce a bare `drain: resolve #N` template and it fails): the existing drain commit-message source-scrape tests stay green (commit template untouched).
- Sweep: Red today — a test in we:scripts/__tests__/backlog-stranded-sweep.test.mjs that `applied[]` carries `blockedBy` and `reason: 'blockers-open'`.

## Proof plan

- Before/after on the live shape: in a throwaway clone of `origin/main`, make a card with an open `blockedBy` and call the exported `resolveLandedItem` on it via a one-line node import. Before: returns `flipped:true` and a `drain: mark card … resolved on land` commit appears. After: returns `reason:'blockers-open'` and `git log` shows no new commit.
- The stranded sweep run in apply mode in that clone shows `applied[].reason === 'blockers-open'` with `blockedBy` and no commit (a dry run never calls the resolver, so it cannot show this).
- The vitest run of the drain test file is red before the change and green after; output pasted in the PR.

## Follow-ups

- Review and prepared-card lint prevention filed as [#xrrmid8](/backlog/xrrmid8-lint-prepared-card-parse-forms-and-review-helper-reuse/): require citation/import of existing normalization helpers and flag accepted parse forms without matching named tests in `check:standards`. This card pairs inline arrays, trailing comments, block lists, and absent/empty lists with the cases above.
- Implementation test gate: require the named `multi-line blockedBy`, `padded id / canonical helper`, `unreadable blocker refuses`, and `invalid blocker never reaches lookup` cases, using deterministic throwing readers and lookup spies. Include their integration assertions for no resolve call or commit.
- Auto-resolve a skipped card when its last blocker resolves (the stranded sweep could do it once the check passes).
- Optional warning in the `resolve` verb of we:scripts/backlog.mjs when blockers are open (human path stays allowed).
- Unify the blocker-status read with the readiness engine's own blocker check so there is one definition of "blocker resolved".
