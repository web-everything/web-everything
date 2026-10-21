---
kind: story
size: 5
parent: "xejcrh1"
status: open
blockedBy: ["xcq5jb9", "xkmrswh"]
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/conveyor/pr-stack.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: stacked PR policy slice 4 - closed or rejected base handling

When a stacked child's base PR is closed or rejected, rebase a low-risk child onto main only on a clean rebase with an unchanged delta fingerprint (a setting); every other child goes to the operator as needs-you. Ruled in xv85eqi.

A Git rebase moves only the child's commits. The drain holds a child on its base through two other things, and the recovery must clear both, or the rebased child never lands:
- **The PR's base branch.** The child PR still targets the closed base's `lane/*` branch. `classifyPr` skips any PR whose `baseRefName` is not the repo's default branch (`base is not main (lane/…)`). GitHub retargets a child only when its base merges (through `retargetStackedPrs`, which runs before the base lands); a base closed without merging never reaches that call. So the recovery retargets the child PR to its own repo's resolved default branch, with the existing `buildRetargetArgs` argv. It never uses a literal `main`, and a default branch that cannot be resolved sends the child to the operator (existing callers fall back to `'main'`; this handler does not).
- **The durable stack edge.** The edge is the `stackParents` entry in the child's lane manifest, and the drain (`planLabelDrain`) keeps waiting on a parent that never lands. So the recovery removes the closed base from every manifest source the drain reads. That means the PR-body lane manifest (rewritten with the existing `embedManifestInBody`) and, when the body carries none, the legacy head-ref `we:.lane-manifest.json`. Writing the cleaned manifest into the body is enough for a legacy child too, because the drain reads the body first.

How the child is moved off the closed base:
- **Which id.** The trigger is a base PR number, but `stackParents` holds item ids. Map the closed base PR to its item id by reading that PR's own manifest (it is closed, so the drain's open-PR read does not have it). If that read fails or gives no item, the child goes to the operator.
- **The recovery hold.** Between the retarget and the edge removal the child targets the default branch while its old head (closed base commits included) still carries a green `test` from the run against the closed base's branch; `classifyPr` cannot tell which base a run was against. So the handler takes the child's existing fix claim (`we:scripts/conveyor/fix-procedure.mjs`, the PR lock `classifyPr` already reads as `fixClaim`) before its first write and holds it, with heartbeats, until the edge removal or the operator route is confirmed. While it is held, `classifyPr` skips the child, so the drain's manifest strip (which needs a `merge` decision) never runs on it. Another writer can still move the head (the drain's rebase-drop, the author lane). The handler's own push names the head it expects to replace (`--force-with-lease=<ref>:<old head>`), so a head that moved under it is a lost race: nothing is pushed, and the child goes to the operator. A head another writer moved after the push no longer matches the marker, so the sweep sends that child to the operator too.
- **Write order.** Each write is confirmed by a fresh read before the next one starts, and the base state and the setting are re-read before each write; a base that reopened or a setting turned off mid-recovery takes the operator route.
  1. The fix claim (above).
  2. For a legacy child (no manifest block in the body), the head-ref manifest copied into the body, edge intact, so the edge no longer depends on a file a head rewrite can drop.
  3. The auto-rebase marker (below).
  4. The retarget, confirmed by a fresh read of the child's `baseRefName` equal to the default branch.
  5. The push of the rebased head, confirmed by the child's remote head equal to the rebased sha.
  6. The edge removal, then the claim release.

  The retarget comes before the push on purpose: CI runs on `pull_request` opened, synchronize and reopened, not on a base edit. Pushed after the retarget, the new head's synchronize run is against the default branch; pushed before it, the run would be against the closed base's branch, and a later retarget would not re-run it. A rebase that leaves the head sha unchanged triggers no new run, so the old run against the closed base's branch would still count: that child goes to the operator. The edge is always the last write.
- **Failure.** A retarget that errors or whose fresh read does not show the default branch, a push that is not confirmed or loses the lease, or a body manifest write that fails, sends the child to the operator and keeps the edge. A child GitHub already closed because the closed base's branch was deleted goes to the operator: GitHub refuses both a retarget and a reopen of such a PR (#2578). The existing lane prune already withholds deleting a branch that an open PR targets, so this happens only when the branch was deleted some other way.
- **Couples.** An impl PR inherits `stackParents` from its WE carrier's manifest. Each half is claimed and retargeted in its own repo, to that repo's default branch. The edge is removed in the carrier's manifest, and only when every half is auto-rebased and retargeted. If any half goes to the operator, or any half's retarget fails, every half does, and the carrier keeps the edge. A base couple where only one half closed (the other half still open) sends the child to the operator: a half must never be moved off an open base.
- **Re-entrant sweep.** A crash between the marker and the edge removal leaves an open child that still names the closed base, and the close trigger will not fire again (the fix claim then expires on its TTL). So every pass, the slice-4 handler also checks each open child whose `stackParents` names an item whose PR was closed without merging, or whose `baseRefName` is the head branch of such a PR in the same repo. The read of closed PRs is bounded; a read that hits its limit or fails acts on no child (each keeps its holds) and is retried next pass. The sweep re-takes the fix claim before any write and finishes only a recovery the handler itself started. Before the retarget, the handler records an auto-rebase marker naming the rebased sha, as a PR comment (no new shared file). Only a marker in the exact shape the handler writes, authored by the trusted conveyor identity, counts; any other comment is ignored. The sweep acts only when that marker names the child's current remote head and the full eligibility check passes again: low-risk class, setting on, fingerprint unchanged against the pre-close delta, trusted same actor, and no `blockedBy` on the base. Then it retargets the child if its `baseRefName` is not yet the default branch, confirms that with a fresh read, and removes the edge. A crash after the marker or after the retarget, but before the push, leaves a marker naming a sha other than the current head, so that child goes to the operator and keeps its edge. Every other child, including one the handler sent to the operator whose head later moved onto main, goes to the operator and keeps its edge. This lives in the slice-4 files, not in `planLabelDrain` or `classifyPr` (the proof-of-land and base gates are unchanged).
- **Operator route.** A child sent to the operator keeps its edge and is never left targeting the default branch on the edge alone: the edge clears as soon as the closed item lands through any new PR, which would land the old head with the closed base's commits. A child the handler never retargeted stays on the closed base's branch. A child the handler (or a crash) already retargeted is retargeted back to the closed base's branch, which still exists because the prune keeps a branch an open PR targets; if that retarget-back fails or its fresh read does not confirm it, the handler parks the child `review:human`, the existing hold only a person clears. The handler releases its fix claim only after one of those holds is confirmed, then posts the child on the needs-you channel.

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/lib/__tests__/pr-merge-gate-base-closed.test.mjs fails before and passes after. Named tests, one per guarantee:
  - `base closed: a low-risk child with a clean rebase and unchanged fingerprint is rebased onto main`.
  - `base closed: a low-risk child with a conflicting rebase goes to the operator`.
  - `base closed: a low-risk child whose fingerprint changed goes to the operator`.
  - `base closed: a normal or guard child always goes to the operator`.
  - `base closed: gate-feeding settings and mixed docs-plus-guard children go to the operator even when settings and docs are in lowRiskClasses` (reuse slice 1's path-derived class precedence).
  - `base closed: an auto-rebased child receives no review:accepted label or carried approval from the rebase and must pass review, CI and proof-of-land gates for its new head` (integration through the rebase handler and drain, with a clean rebase and unchanged fingerprint; stale acceptance on the old head cannot authorize the new head).
  - `base closed: an auto-rebased child is retargeted to the default branch and has the closed base removed from stackParents in every manifest source the drain reads, and the real classifyPr and planLabelDrain then land it` (integration through the rebase handler, the real `classifyPr` and the real `planLabelDrain`, with a clean rebase and unchanged fingerprint. Never seed the candidate with a preset `decision`: build the child's post-recovery PR state from the handler's writes (its `baseRefName` after the retarget, its pushed head, and every other gate green: certified, `test` green, `MERGEABLE`, `CLEAN`, a real body), and take the decision from `classifyPr` with `defaultBranch` resolved for the child's repo. Pass that verdict into `planLabelDrain`. Use a hash parent id such as `xbase01`, never a numeric one. Read the manifest back with the drain's precedence: the body through `extractManifestFromBody` first, and the legacy readers (`readLegacyLocalManifestAt`, `readRemoteManifestViaApi`) only when the body has no manifest block. Cover a body-manifest child and a legacy head-ref child; for the legacy child the cleaned manifest is written into the body, so the body read wins. Assert `classifyPr` returns `merge` and the child is in `ready`. Controls: the same fixture with the base left on `lane/closed-base` has `classifyPr` return `skip` with `base is not main (lane/closed-base)`; the same fixture with the edge kept has the child in `deferred` with `xbase01` in `waitOn`).
  - `base closed: the retarget uses the child repo's resolved default branch, never a literal main` (a fixture repo whose default branch is `trunk`; `buildRetargetArgs` receives `trunk`, and `classifyPr` with `defaultBranch: 'trunk'` returns `merge`).
  - `base closed: the closed base PR number is mapped to its item id through that PR's own manifest; an unreadable or item-less base manifest sends the child to the operator`.
  - `base closed: writes happen in the order fix claim, legacy body manifest, marker, retarget, push, edge removal, claim release; the edge is removed only after a fresh read shows baseRefName equal to the default branch and the child's remote head equal to the rebased sha`.
  - `base closed: while the recovery holds the child's fix claim, the real classifyPr skips the child even with the retarget done, the old head's test green and the edge already read as cleared, so the manifest strip never runs on it` (the window between the retarget and the push).
  - `base closed: a legacy child's manifest is copied into the body with the edge intact before the marker; a head rewrite that drops the head-ref manifest file afterwards leaves the edge in place and the child deferred`.
  - `base closed: a retarget that errors, or whose fresh read does not show the default branch, sends the child to the operator, pushes nothing and keeps the edge`.
  - `base closed: a push that is not confirmed leaves the edge in place and sends the child to the operator` (the operator route then retargets it back; see below).
  - `base closed: the handler's push is leased on the old head; a head moved by another writer (the drain's rebase-drop, the author lane) makes the push fail and sends the child to the operator`.
  - `base closed: the retarget is written before the push, so the push's synchronize run is the first run of the new head; a rebase that leaves the head sha unchanged goes to the operator` (an ordering test: the handler's recorded call order has the retarget before the push).
  - `base closed: a default branch that cannot be resolved for the child's repo sends the child to the operator; no literal main is used`.
  - `base closed: a base that reopens, or a setting turned off, between two recovery writes stops the recovery and takes the operator route` (re-read before each write).
  - `base closed: a child GitHub already closed because the closed base's branch was deleted goes to the operator; no retarget or reopen is attempted`.
  - `base closed: for a couple, each half is claimed and retargeted to its own repo's default branch, and the edge is removed from the carrier's manifest only when every half is auto-rebased and retargeted; if any half goes to the operator or any half's retarget fails, every half does and the carrier keeps the edge`.
  - `base closed: a base couple where only one half closed sends the child to the operator; no half is moved off an open base`.
  - `base closed: a pass after a crash anywhere between the marker and the edge removal finds the open child still naming the closed base, retargets it if its base is still the closed base's branch, and finishes the removal only when the handler's auto-rebase marker names the current head and eligibility passes again` (cover a crash after the push and before the edge removal, which the sweep finishes; a child whose marker names the current head but whose base is not the default branch, which the sweep retargets and confirms before removing the edge; and a crash after the marker or after the retarget but before the push, which leaves a marker naming another sha, so the child goes to the operator and keeps its edge). The sweep re-takes the fix claim before any write.
  - `base closed: the sweep matches a child's baseRefName to a closed base's head branch only in the same repo; a same-named lane branch in another repo is not a match`.
  - `base closed: the sweep's read of PRs closed without merging is bounded; a read that hits its limit or fails acts on no child, and each child keeps its holds`.
  - `base closed: a child sent to the operator is never left targeting the default branch on its edge alone` (a child never retargeted stays on the closed base's branch; a child already retargeted is retargeted back to it and confirmed; if that fails, it is parked `review:human`. In each case the real `classifyPr` skips the child even after the closed item lands through a new PR and the edge clears. The fix claim is released only after one of those holds is confirmed).
  - `base closed: the sweep never clears the edge of a child the handler sent to the operator (a guard child, or one whose blockedBy names the base), even after its head later moves onto main; it goes to the operator`.
  - `base closed: the sweep sends a child to the operator when the marker is missing, names another sha, or the eligibility re-check fails`.
  - `base closed: an auto-rebase marker written by another author, or in any other shape, is ignored by the sweep`.
  - `base closed: only the closed base's edge is removed; every other stackParents and blockedBy edge of the child is kept`.
  - `base closed: a child whose blockedBy also names the closed base's item goes to the operator, never an automatic edge removal`.
  - `base closed: a child sent to the operator keeps its stack edge, so the drain never lands it until the operator acts`.
  - `base closed: a manifest update that fails or is partial sends the child to the operator, never leaving a rebased child that silently waits on the closed base`.
  - `base rejected is handled the same as closed`.
  - `the auto-rebase behaviour follows the setting; turning it off sends every child to the operator`.
  - `an unreadable base state fails closed to the operator`.
  - `an incomplete diff read fails closed to the operator, never to an automatic rebase`.
  - `a partial base-state read (fields missing or cut short) fails closed to the operator`.
  - `a rebase that errors or times out without a conflict goes to the operator`.
  - `a fingerprint or risk class that cannot be computed goes to the operator`.
  - `auto-rebase setting: an unset repo layer resolves to the cascade default of enabled and a low-risk clean child with unchanged fingerprint rebases onto main`.
  - `auto-rebase setting: no resolved cascade value (including no default), or an unreadable cascade result, sends the child to the operator`.
  - `untrusted text: PR body or card text claiming low-risk does not change the class; class and fingerprint come from the diff and paths`.
  - `shared state: a child sent to the operator is posted on the existing needs-you channel and no new shared file is written`.
  - `identity: a child or base PR by a different actor goes to the operator`.
  - `identity: a child or base that is not a trusted lane PR goes to the operator`.
  - `state over time: the decision uses the base and child state read when the base closes, never an earlier cached read`.
  - `state over time: reopening a closed base re-evaluates the child at reopen time instead of reusing the close-time decision`.
  - `who wrote it: an automation's comment marking a child low-risk does not make it low-risk`.

## Non-goals

- [N1] Does not change the existing retarget when the base merges (`retargetStackedPrs`); the close path only reuses its argv builder `buildRetargetArgs`. Does not change `classifyPr`'s base gate or `planLabelDrain`, and does not define the setting (slice 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — class and fingerprint come from the diff and paths, not PR text.
2. **Truncated reads** — an incomplete diff or state read, or a default branch that cannot be resolved, goes to the operator. The sweep's bounded read of closed PRs acts on no child when it hits its limit or fails.
3. **Shared state files** — adds no new shared file; the operator route uses the existing needs-you channel. The handler holds the child's existing fix claim for the whole recovery, so `classifyPr` skips the child throughout. The durable writes, in order, are the legacy manifest copied into the body (edge intact), the auto-rebase marker (a PR comment), the child PR's base retarget to its repo's default branch, the rebased head push (leased on the old head, so another writer's push is a lost race that goes to the operator), and removing the closed base from the child's lane manifest (the PR body, or the carrier's body for a couple). The edge removal comes last, only after a fresh read confirms both the new base and the rebased head on the remote. A crash anywhere between the marker and the edge removal is caught by the per-pass sweep, which re-takes the claim.
4. **Fail closed** — any unknown goes to the operator, never to an automatic rebase. A failed or unconfirmed retarget, a lost push lease, a sha the rebase left unchanged, or a failed or partial stack-edge removal, also goes to the operator. A child routed there keeps its edge and is never left targeting the default branch on the edge alone: it is retargeted back to the closed base's branch, or parked `review:human` when that fails.
5. **Identity scoping** — only trusted same-actor lane PRs are handled automatically; the sweep matches a base branch only within the child's own repo.
6. **State over time** — evaluated when the base closes; a later reopen re-evaluates. The base state and the setting are re-read before each recovery write, so a reopen or a setting change mid-recovery takes the operator route, which undoes the retarget.
7. **Who wrote it** — an automation's comment never marks a child low-risk.
