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
- **The PR's base branch.** The child PR still targets the closed base's `lane/*` branch. `classifyPr` skips any PR whose `baseRefName` is not the repo's default branch (`base is not main (lane/…)`), and the drain's candidate read filters on the base too. GitHub retargets a child only when its base merges (through `retargetStackedPrs`, which runs before the base lands); a base closed without merging never reaches that call. So the recovery retargets the child PR to its own repo's resolved default branch, with the existing `buildRetargetArgs` argv. It never uses a literal `main`.
- **The durable stack edge.** The edge is the `stackParents` entry in the child's lane manifest, and the drain (`planLabelDrain`) keeps waiting on a parent that never lands. So the recovery removes the closed base from every manifest source the drain reads. That means the PR-body lane manifest (rewritten with the existing `embedManifestInBody`) and, when the body carries none, the legacy head-ref `we:.lane-manifest.json`. Writing the cleaned manifest into the body is enough for a legacy child too, because the drain reads the body first.

How the child is moved off the closed base:
- **Which id.** The trigger is a base PR number, but `stackParents` holds item ids. Map the closed base PR to its item id by reading that PR's own manifest (it is closed, so the drain's open-PR read does not have it). If that read fails or gives no item, the child goes to the operator.
- **Write order.** First the auto-rebase marker (below). Then the retarget, confirmed by a fresh read of the child's `baseRefName` equal to the default branch. Then the push of the rebased head, confirmed by the child's remote head equal to the rebased sha. Last, the edge removal. The retarget comes before the push on purpose: CI runs on `pull_request` opened, synchronize and reopened, not on a base edit. Pushing first would test the new head against the closed base's branch, and a later retarget would not re-run it. Pushed after the retarget, the new head's required checks run against the default branch. The edge is always the last write, so every in-between state is still held by it. A child that still carries the closed base's commits keeps waiting, even when it already targets the default branch.
- **Failure.** A retarget that errors or whose fresh read does not show the default branch, or a push that is not confirmed, sends the child to the operator and keeps the edge. A child GitHub already closed because the closed base's branch was deleted goes to the operator: GitHub refuses both a retarget and a reopen of such a PR (#2578). The existing lane prune already withholds deleting a branch that an open PR targets, so this happens only when the branch was deleted some other way.
- **Couples.** An impl PR inherits `stackParents` from its WE carrier's manifest. Each half is retargeted in its own repo, to that repo's default branch. The edge is removed in the carrier's manifest, and only when every half is auto-rebased and retargeted. If any half goes to the operator, or any half's retarget fails, every half does, and the carrier keeps the edge. A half that was already retargeted is still held by that edge.
- **Re-entrant sweep.** A crash between the marker and the edge removal leaves an open child that still names the closed base, and the close trigger will not fire again. So every pass, the slice-4 handler also checks each open child whose `stackParents` names an item whose PR was closed without merging, or whose `baseRefName` is the head branch of such a PR. The sweep finishes only a recovery the handler itself started. Before the retarget, the handler records an auto-rebase marker naming the rebased sha, as a PR comment (no new shared file). Only a marker in the exact shape the handler writes, authored by the trusted conveyor identity, counts; any other comment is ignored. The sweep acts only when that marker names the child's current remote head and the full eligibility check passes again: low-risk class, setting on, fingerprint unchanged against the pre-close delta, trusted same actor, and no `blockedBy` on the base. Then it retargets the child if its `baseRefName` is not yet the default branch, confirms that with a fresh read, and removes the edge. A crash after the marker or after the retarget, but before the push, leaves a marker naming a sha other than the current head, so that child goes to the operator and keeps its edge. Every other child, including one the handler sent to the operator whose head later moved onto main, goes to the operator and keeps its edge. This lives in the slice-4 files, not in `planLabelDrain` or `classifyPr` (the proof-of-land and base gates are unchanged).
- **Operator route.** A child sent to the operator is neither retargeted nor stripped of its edge. It stays on the closed base's branch, so both drain holds stay in place until the operator acts.

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
  - `base closed: writes happen in the order marker, retarget, push, edge removal; the edge is removed only after a fresh read shows baseRefName equal to the default branch and the child's remote head equal to the rebased sha`.
  - `base closed: a retarget that errors, or whose fresh read does not show the default branch, sends the child to the operator, pushes nothing and keeps the edge`.
  - `base closed: a push that is not confirmed leaves the edge in place and sends the child to the operator, even though the child already targets the default branch` (the drain keeps it in `deferred`).
  - `base closed: the new head's required checks come from a run against the default branch; a test result from a run against the closed base's branch does not count` (the retarget precedes the push, so the push's synchronize run is the one the drain reads).
  - `base closed: a child GitHub already closed because the closed base's branch was deleted goes to the operator; no retarget or reopen is attempted`.
  - `base closed: for a couple, each half is retargeted to its own repo's default branch, and the edge is removed from the carrier's manifest only when every half is auto-rebased and retargeted; if any half goes to the operator or any half's retarget fails, every half does and the carrier keeps the edge`.
  - `base closed: a pass after a crash anywhere between the marker and the edge removal finds the open child still naming the closed base, retargets it if its base is still the closed base's branch, and finishes the removal only when the handler's auto-rebase marker names the current head and eligibility passes again` (cover a crash after the push and before the edge removal, which the sweep finishes; a child whose marker names the current head but whose base is not the default branch, which the sweep retargets and confirms before removing the edge; and a crash after the marker or after the retarget but before the push, which leaves a marker naming another sha, so the child goes to the operator and keeps its edge).
  - `base closed: a child sent to the operator is not retargeted; it stays on the closed base's branch and classifyPr keeps skipping it`.
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
2. **Truncated reads** — an incomplete diff or state read goes to the operator.
3. **Shared state files** — adds no new shared file; the operator route uses the existing needs-you channel. The durable writes, in order, are the auto-rebase marker (a PR comment), the child PR's base retarget to its repo's default branch, the rebased head push, and removing the closed base from the child's lane manifest (the PR body, or the carrier's body for a couple). The edge removal comes last, only after a fresh read confirms both the new base and the rebased head on the remote. A crash anywhere between the marker and the edge removal is caught by the per-pass sweep.
4. **Fail closed** — any unknown goes to the operator, never to an automatic rebase. A failed or unconfirmed retarget, or a failed or partial stack-edge removal, also goes to the operator, and a child routed there keeps its edge.
5. **Identity scoping** — only trusted same-actor lane PRs are handled automatically.
6. **State over time** — evaluated when the base closes; a later reopen re-evaluates.
7. **Who wrote it** — an automation's comment never marks a child low-risk.
