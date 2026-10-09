---
bornAs: xialgas
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/lane-salvage.mjs", "we:scripts/lib/salvage-index.mjs", "we:scripts/lib/__tests__/lane-salvage.test.mjs", "we:scripts/lib/__tests__/salvage-index.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "1e6f1bfb6e735f41fe303285bc76b981a8d8860b"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2888's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). Preserve the six review obligations: fail-closed mtime coverage, special-file copy protection, symlink-root protection, registered-worktree exclusion through a lane alias, dangling-root handling, and executable deletion-containment lint.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2888@140828a7bfdef76029bb8ce23228987f91fc29c4

## Progress

- **Premise correction:** the original references to lines 279, 420, 240 and 244 have moved. The current sites are `we:scripts/lib/lane-salvage.mjs:390` (mtime catch), `we:scripts/lib/lane-salvage.mjs:447` (copy walker), and `we:scripts/lib/lane-salvage.mjs:251` (litter discovery). The mtime catch already substitutes `nowMs`; the debt is direct gate coverage, not inventing a new liveness gate. Existing unreadability coverage at `we:scripts/lib/__tests__/lane-salvage.test.mjs:459` tests the reader and salvage, not that catch.
- **Scope correction:** the original four-file scope remains sufficient, including one existing matching test file per source. However, deletion protection requires a runtime repair as well as lint: the plain and globbed deletions are guarded at `we:scripts/lib/salvage-index.mjs:279` and `we:scripts/lib/salvage-index.mjs:282`, while empty-output-directory deletion at `we:scripts/lib/salvage-index.mjs:283` is not. Existing containment tests at `we:scripts/lib/__tests__/salvage-index.test.mjs:174` and `we:scripts/lib/__tests__/salvage-index.test.mjs:225` do not enforce every deletion call site.
- **Root correction:** `we:scripts/lib/lane-salvage.mjs:258` calls lstat but discards its type; `we:scripts/lib/lane-salvage.mjs:271` then descends into the root. Child symlinks already remain leaves. A dangling root therefore reaches readdir and throws, whereas a symlinked root can expose outside content. Lane-path canonicalization already exists at `we:scripts/lib/lane-salvage.mjs:253`; retain it and add alias regression coverage.
- **Special-file correction:** the unconditional fallback at `we:scripts/lib/lane-salvage.mjs:455` is still present. #4397 overlaps this obligation. Its current description asserts a catchable error for all special files; distinguish a FIFO's possible blocking read (hang) from a socket's error. This preparation establishes the unchecked call by source inspection, not a claimed live reproduction. Correct #4397 when its owner reconciles the overlap; this preparation edits only this card.
- **Sizing:** retain size 3: two bounded runtime modules and their existing test suites. No delivery claim or stamp is made by this preparation.

## Design

1. In `we:scripts/lib/__tests__/lane-salvage.test.mjs`, exercise `laneLivenessGate` with empty injected agent/cwd readers and a deterministic mtime-read failure. A temporary non-repository directory makes the git read inside `newestContentMtimeMs` throw without permission-dependent fixtures. Assert the reader throws, then assert the gate returns ineligible with a quiet-period reason using a positive `quietMs`. Preserve the existing zero-quiet-period semantics; the production catch is at `we:scripts/lib/lane-salvage.mjs:390`.
2. In `we:scripts/lib/lane-salvage.mjs:447`, explicitly allow symlinks, directories and regular files; skip other lstat types before invoking any copy/read of their contents. This is the original review's permitted skip behavior. Do not manufacture sibling placeholder filenames that could collide with real litter. Preserve catchable errors for supported types, exclusive destination writes, and the no-reset-on-failed-salvage contract.
3. In `we:scripts/lib/lane-salvage.mjs:251`, retain root lstat results. Treat a symlinked root, including a dangling one, as a single leaf with `rel: '.'`, so salvage copies the link itself to the litter destination root and never enumerates its target. Truly absent roots still return an empty list; other read errors still propagate. The destination preparation at `we:scripts/lib/lane-salvage.mjs:510` must create only the destination's parent before copying this root leaf. This preserves the link rather than silently treating existing content as absent.
4. Keep canonical lane resolution and registered-worktree exclusion. Test through an alias of the lane, with both a registered worktree and an unregistered sibling, in `we:scripts/lib/__tests__/lane-salvage.test.mjs`.
5. Guard empty-output-directory removal with `isUnderSalvageRoot(e.outDir, root)` in `we:scripts/lib/salvage-index.mjs:283`. Add a static source guard in `we:scripts/lib/__tests__/salvage-index.test.mjs` using the existing TypeScript parser dependency: enumerate imported filesystem `rmSync` and `unlinkSync` calls (including import aliases), require each call to be inside the true branch of an explicit containment condition for that exact operand and root, and reject unsupported deletion forms. Recognize conjunctions only where the containment term is required for truth. A nearby comment or unrelated containment call must not satisfy the guard. Keep the guard local to this module; no new repository-wide policy engine.

## MVP

Deliver the six obligations through the two scoped runtime modules and their paired test files. Include root-leaf handling, the copy allowlist, the missing output-directory guard, and regression/static checks. Preserve ordinary file copies, nested registered-worktree exclusions, link target spelling and existing expiry behavior. Shared traversal extraction and edits to other cards are outside this implementation slice.

## Test plan

- `we:scripts/lib/__tests__/lane-salvage.test.mjs`: direct throwing-reader gate test; real lane alias with registered and unregistered children; external-target root symlink with a sentinel that never appears in the salvage output; dangling root symlink that survives `salvageLane` as a link with the same target. Verify link type with lstat, not exists checks that follow a dangling target.
- `we:scripts/lib/__tests__/lane-salvage.test.mjs`: real FIFO and Unix socket fixtures alongside a regular file and child symlink. Run the potentially blocking salvage operation in a child process with a parent-enforced timeout and forced termination; a Vitest timeout alone cannot interrupt synchronous filesystem I/O. Assert timely successful salvage, preserved ordinary content and symlink, and absent special-file copies. Clean up socket servers and children in finally blocks. Skip only explicitly unsupported platforms, with a visible reason.
- `we:scripts/lib/__tests__/salvage-index.test.mjs`: forged expired rows pointing to an empty external output directory and to the salvage root must leave those directories intact; a legitimate empty output directory must still be removed. Retain existing symlink-ancestor containment cases.
- `we:scripts/lib/__tests__/salvage-index.test.mjs`: static checker fixtures accept correctly guarded calls and reject bare deletion, wrong operand/root, comments-only guards, disjunctive guards, aliases bypassing checks, and deletion after a guard's branch has ended. Scan the real runtime source as an assertion.

## Proof plan

Use the host heavy-run queue exclusively. From the WE checkout, run the following commands (command operands below are shell-relative paths in this repository):

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/lane-salvage.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/salvage-index.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

First add the regressions and record failures for root traversal, special-file handling and unguarded directory cleanup. The direct mtime-catch test should already pass; temporarily removing its catch must make that test fail. Likewise, remove each containment guard in isolated mutations and verify the static test rejects each site. Keep FIFO reproduction in the timeout-bounded child. Restore mutations, rerun both suites through the queue, and retain output showing actual executed cases and platform skips. Do not claim a FIFO reproduction from source inspection alone.

For throw-path review, grep each changed helper's callers and record their error behavior. Current mtime composition flows through `we:scripts/lib/lane-salvage.mjs:390`; gate callers include `we:scripts/lane-pool.mjs:3895`, `we:scripts/lane-pool.mjs:3957`, `we:scripts/lane-pool.mjs:4000`, and `we:scripts/conveyor/lane-pool-health-watch.mjs:344`. Revalidate these references at implementation time; no caller edits are currently required.

## Follow-ups

- Reconcile #4397 with the delivered allowlist and timeout-bounded evidence; correct its universal throw/abort premise to distinguish FIFO hangs from socket errors. Do not build two competing special-file fixes.
- Consider shared safe-directory traversal only when another caller needs it; preserve lstat-before-descent and leaf-symlink semantics.
- Carry the review obligation forward: a new helper throw path must identify its callers by grep and test their error handling. Any durable review-guideline codification belongs in a separately scoped documentation change.

## Done when

All six obligations above have executable coverage, the three queued commands pass, and the targeted mutations fail for the intended reasons. Outside target content and external expiry directories remain untouched. The FIFO case terminates within its parent-enforced deadline. Preparation alone does not meet this delivery criterion.
