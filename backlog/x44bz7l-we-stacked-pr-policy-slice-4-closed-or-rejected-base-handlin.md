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

The auto-rebase also removes the closed base from the child's durable stack edge. A Git rebase does not touch it: the edge is the `stackParents` entry in the child's lane manifest, and the drain (`planLabelDrain`) keeps waiting on a parent that never lands. So the recovery removes the closed base from every manifest source the drain reads. That means the PR-body lane manifest (rewritten with the existing `embedManifestInBody`) and, when the body carries none, the legacy head-ref `we:.lane-manifest.json`. Writing the cleaned manifest into the body is enough for a legacy child too, because the drain reads the body first.

How the edge is removed:
- **Which id.** The trigger is a base PR number, but `stackParents` holds item ids. Map the closed base PR to its item id by reading that PR's own manifest (it is closed, so the drain's open-PR read does not have it). If that read fails or gives no item, the child goes to the operator.
- **Write order.** Remove the edge only after the remote head of the child equals the rebased sha. Never remove it first: a child that still carries the closed base's commits must keep waiting.
- **Couples.** An impl PR inherits `stackParents` from its WE carrier's manifest. The edge is removed in the carrier's manifest, and only when every half of the couple is auto-rebased. If any half goes to the operator, every half does, and the carrier keeps the edge.
- **Re-entrant sweep.** A crash between the push and the manifest edit leaves a child on main that still names the closed base, and the close trigger will not fire again. So every pass, the slice-4 handler also checks each open child whose `stackParents` names an item whose PR was closed without merging. The sweep finishes only a removal the handler itself started. Before the push, the handler records an auto-rebase marker naming the rebased sha, as a PR comment (no new shared file). The sweep finishes the removal only when that marker names the child's current remote head and the full eligibility check passes again: low-risk class, setting on, fingerprint unchanged against the pre-close delta, trusted same actor, and no `blockedBy` on the base. Every other child, including one the handler sent to the operator whose head later moved onto main, goes to the operator and keeps its edge. This lives in the slice-4 files, not in `planLabelDrain` (the proof-of-land gate is unchanged).

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/lib/__tests__/pr-merge-gate-base-closed.test.mjs fails before and passes after. Named tests, one per guarantee:
  - `base closed: a low-risk child with a clean rebase and unchanged fingerprint is rebased onto main`.
  - `base closed: a low-risk child with a conflicting rebase goes to the operator`.
  - `base closed: a low-risk child whose fingerprint changed goes to the operator`.
  - `base closed: a normal or guard child always goes to the operator`.
  - `base closed: gate-feeding settings and mixed docs-plus-guard children go to the operator even when settings and docs are in lowRiskClasses` (reuse slice 1's path-derived class precedence).
  - `base closed: an auto-rebased child receives no review:accepted label or carried approval from the rebase and must pass review, CI and proof-of-land gates for its new head` (integration through the rebase handler and drain, with a clean rebase and unchanged fingerprint; stale acceptance on the old head cannot authorize the new head).
  - `base closed: an auto-rebased child has the closed base removed from stackParents in every manifest source the drain reads, and planLabelDrain then puts it in ready` (integration through the rebase handler and the real `planLabelDrain`, with a clean rebase and unchanged fingerprint. Use a hash parent id such as `xbase01`, never a numeric one, and a child candidate with `decision: 'merge'` and every other gate green. Read the manifest back with the drain's precedence: the body through `extractManifestFromBody` first, and the legacy readers (`readLegacyLocalManifestAt`, `readRemoteManifestViaApi`) only when the body has no manifest block. Cover a body-manifest child and a legacy head-ref child; for the legacy child the cleaned manifest is written into the body, so the body read wins. Assert the child is in `ready`. Control: the same fixture with the edge kept has the child in `deferred` with `xbase01` in `waitOn`).
  - `base closed: the closed base PR number is mapped to its item id through that PR's own manifest; an unreadable or item-less base manifest sends the child to the operator`.
  - `base closed: the edge is removed only after the child's remote head equals the rebased sha; a push that is not confirmed leaves the edge in place and sends the child to the operator`.
  - `base closed: for a couple, the edge is removed from the carrier's manifest only when every half is auto-rebased; if any half goes to the operator, every half does and the carrier keeps the edge`.
  - `base closed: a pass after a crash between the rebase push and the manifest edit finds the open child still naming the closed base and finishes the removal only when the handler's auto-rebase marker names the current head and eligibility passes again`.
  - `base closed: the sweep never clears the edge of a child the handler sent to the operator (a guard child, or one whose blockedBy names the base), even after its head later moves onto main; it goes to the operator`.
  - `base closed: the sweep sends a child to the operator when the marker is missing, names another sha, or the eligibility re-check fails`.
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

- [N1] Does not change the existing retarget when the base merges (retargetStackedPrs), and does not define the setting (slice 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — class and fingerprint come from the diff and paths, not PR text.
2. **Truncated reads** — an incomplete diff or state read goes to the operator.
3. **Shared state files** — adds no new shared file; the operator route uses the existing needs-you channel. The only durable write is removing the closed base from the child's lane manifest (the PR body, or the carrier's body for a couple). It happens only after the rebased head is confirmed on the remote. A crash between the push and the edit is caught by the per-pass sweep.
4. **Fail closed** — any unknown goes to the operator, never to an automatic rebase. A failed or partial stack-edge removal also goes to the operator, and a child routed there keeps its edge.
5. **Identity scoping** — only trusted same-actor lane PRs are handled automatically.
6. **State over time** — evaluated when the base closes; a later reopen re-evaluates.
7. **Who wrote it** — an automation's comment never marks a child low-risk.
