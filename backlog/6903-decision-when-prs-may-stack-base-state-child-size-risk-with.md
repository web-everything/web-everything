---
bornAs: xv85eqi
kind: decision
size: 3
parent: "3383"
status: resolved
scope: ["we:backlog/"]
dateOpened: "2026-10-17"
dateStarted: "2026-10-17"
dateResolved: "2026-10-17"
codifiedIn: "docs/agent/platform-decisions.md#stacked-pr-policy-configurable"
preparedDate: "2026-10-17"
preparedAgainstSha: "2fd013ac53894e9f955069bce0d82a08f6e0ac8d"
relatedTo: ["2387", "2393", "2394", "4631", "6239", "6236"]
tags: [stacked-prs, drain, free-scope, decision-prep]
---

# Decision: when PRs may stack — base state × child size/risk, with settings

## Ruling

**Ruled 2026-10-17 by the operator (Nicolas Gilbert), in conversation.** Verbatim: *"Ok, make sure the stacking is a configurable policy"*. The rule is codified at
[we:docs/agent/platform-decisions.md#stacked-pr-policy-configurable](../docs/agent/platform-decisions.md#stacked-pr-policy-configurable).
The prepared text below is kept as the lineage; where it differs from this section, this section wins.

- **Fork 1 = (a).** Guard or merge-path code never stacks on an in-review or fixing base; the matrix ships as default settings values. Gate-feeding settings paths count as guard, and guard or merge-path classification takes precedence over low-risk membership in a mixed child. Slice 1's named `class:` tests pin both amendments.
- **Fork 2 = (a).** A low-risk child rebases onto main only on a clean rebase with an unchanged delta fingerprint; all else goes to the operator. The cascade default enables this handling; an unset repo layer uses that default, while an unreadable or absent resolved cascade value goes to the operator. Rebase grants no approval and preserves review, CI and proof-of-land gates for the new head (slice 4's named `base closed:` and `auto-rebase setting:` tests). The auto-rebase also clears both drain holds on the old base: it retargets the child PR to its repo's default branch (GitHub retargets only when a base merges, so `classifyPr` would keep skipping a child left on the closed base's branch), and it removes the closed base from the child's `stackParents` edge in every lane manifest the drain reads. Otherwise the drain waits forever on a parent that never lands. A child sent to the operator keeps its edge and is never left targeting the default branch on its edge alone (slice 4's operator-route test). Because the edge, the fix claim and the markers can each fail or expire, the drain also refuses, independently of all three, any child whose head still carries a closed (unmerged) base's commits, and a recovery read the sweep cannot complete parks the child `review:human` (slice 4's closed-base ancestry tests).
- **Amendment.** The WHOLE policy is a configurable cascade policy, each value with its source logged: every matrix cell (base state x child class), the safety floor (default: guard or merge-path never stacks on an in-review or fixing base; changeable only by an operator-sourced setting, never by an agent), the urgent classes, `stack.smallChildMaxLines` (50), `stack.lowRiskClasses`, `stack.maxDepth` (1), `stack.onBaseHeadMove` (restack + delta re-review) and the closed or rejected base handling.

**Build slices:** the four children of epic 6899 (`parent: "6899"`): 6896 (policy settings and evaluator), 6898 (free-scope `--stack-on`), 6900 (drain ordered landing, restack and delta re-review), and 6901 (base-closed handling). The epic implements this decision; the slices are not children of this decision.

Operator ask, 2026-10-17: "We'll need to normalise when we can use stacked pr, both in circumstance and timing, like a pr waiting for drain could probably be stacked on with little cost or risk, and in some cases it might be cheaper to use stacked pr for urgent things" … "Or when little change or risk maybe". Operator go ("Yes") to file and prepare one card.

## Digest

Stacking is already built in pieces, but no rule says WHEN a PR may stack. Free-scope still reports a file held by an
already-approved PR as OCCUPIED, so a child that should simply ride on its base is blocked. On 2026-10-17 this stopped
the overlap-yield follow-up (PR #5525), drain fix 3 (card xrrtegi), and the red-team settings (cards xq2bksy,
xx3ffrw, xfrggva, xdbo9nr). Their files were held by PRs that were approved (#5518, #5480) or in fixing.

**Proposal.** Two axes. Base state: approved-waiting, approved-held (for example red-team-pending), in review or fixing.
Child size and risk: small and low-risk (cards, settings, docs, or a narrow fix under about 50 lines outside guard
code); normal; touches guard or merge-path code.

| Child | Approved-waiting | Approved-held | In review or fixing |
| --- | --- | --- | --- |
| Small, low-risk | stack | stack | stack |
| Normal | stack | urgent only | emergency only |
| Guard / merge-path | stack | urgent only | never |

"Urgent" = expedite-class findings, plus fixes that unblock other PRs.

Safety mechanics: the drain lands in order, base first. Review judges the child's own delta only. When the base head
moves, the child is restacked; approval carries when only the base changed, and only the child delta is re-reviewed. If
the base is closed or rejected, the child is rebased onto main or goes to the operator. Max depth is 1 (2 later).

The low-risk and guard classes come from the review-stringency class list (decision xugqjw1, epic xrlwbd7). Those two
cards are not in this checkout's backlog/ folder, so their ids are cited as the operator gave them and are not re-read here.

## What exists against what is new

| Piece | Exists (file:line) | New in this card |
| --- | --- | --- |
| Serial-batch stacking planner, stack only when the drain proof gate is live | `we:scripts/lane-stack.mjs:3-31`, `we:scripts/readiness/overlap-chain.mjs:58` (depth cap 4), `:130` (`createStackPlan`), `:253-261` (depth-cap fallback to siblings) | Today it stacks only on declared file overlap inside one batch, never by base state or child risk. |
| Capability gate (#2393 proof of land) | `we:scripts/readiness/drain-capability.mjs:61` (`stackingSupported`), `we:scripts/readiness/drain-capability.json` (gateVersion 1) | Reused unchanged. |
| Drain holds a child until every stack parent is proven landed | `we:scripts/merge-ai-prs.mjs:2484-2510` (`stackProven`), `:2541` (`stackWait`); child off a `lane/*` base is held at `:1010`, `:1072` | Reused unchanged: "base first" already holds. |
| Drain retargets a child to main when its base lands | `we:scripts/lib/pr-merge-gate.mjs:311` (`retargetStackedPrs`) | Nothing for a base that is closed or rejected (Fork 2). |
| Review and CI while the base is open | `we:scripts/settings/stack.json:1` (`reviewWhileBaseOpen`), `we:scripts/lib/stack-review-while-open.mjs:30,64`, `we:scripts/operations/promote-draft-pr-dispatch.mjs:290-328` | Reused. |
| Review judges only the child's delta; accept held while the base is open; accept carried when the net diff is byte-identical | `we:scripts/conveyor/review-stack-base.mjs:3-22`, `:120` (`findStackBases`), `:168-189` (stack marker) | Re-point the hold marker on a moved base (Supported by default). |
| Restack when the base head moves, bottom first, capped rounds | `we:scripts/conveyor/pr-stack.mjs:25` (defaults), `:243` (`capReached`), `we:scripts/settings/pr-stack.json:1` | Reused: it is `stack.onBaseHeadMove`'s mechanism. |
| Free-scope excludes a PR's whole base chain, by hand | `we:scripts/operations/free-scope-cli.mjs:36` (`--exclude-pr` repeats), `we:scripts/operations/free-scope.mjs:135-142` (`excludePr`) | Automatic base-chain exclusion gated by the matrix (free-scope item above). Today nothing passes the flag, so callers see OCCUPIED. |
| Matrix of base state x child risk, the six `stack.*` settings | none | The floor (Fork 1), the default matrix and the settings list. |

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — the safety floor for stacking | **(a) Guard or merge-path code never stacks on an in-review or fixing base. Class is read from touched paths, and "emergency" is operator-flagged only. The other matrix cells ship as default settings values.** | (b) Approved-waiting bases only | High on the floor |
| 2 — base closed or rejected | **(a) A low-risk child rebases onto main by itself only when the rebase is clean and its delta fingerprint is unchanged; every other child goes to the operator** | (b) Always the operator | Medium |

Review on a moved base and free-scope on base files are NOT forks; they are in "Supported by default" below (the screen showed they are builds that follow from Fork 1).

## Fork 1 — the safety floor: which cells may never stack

*Fork-existence:* the branch "stack anything on anything" is broken for guard code: a guard or merge-path child riding an unreviewed base could land its guard change on top of base code no one has approved, and the drain's proof gate (`we:scripts/merge-ai-prs.mjs:2484`) only orders landing, it does not review. Cells above that floor are tunable values, so they ship as default settings, not as the ruling.

Options:

- (a) **Rule the floor; ship the matrix as defaults.** The floor: guard or merge-path code never stacks on an in-review or fixing base, and never on an approved-held base unless urgent. The default matrix (small and low-risk stacks anywhere; normal stacks on approved-waiting, on approved-held when urgent, in review only in an emergency) lives in `stack.allowedBaseStates` and can be tuned without a new decision. Class is derived from the touched paths: any path under `we:scripts/settings/` that feeds the drain, review or merge gates counts as guard class whatever the card label says. "Emergency" is operator-flagged only, never self-asserted by an agent.
- (b) Approved-waiting bases only. Safe and simple, but it leaves the urgent and small low-risk cases blocked, which is what hit the red-team settings cards.

Cost note from existing code: every stacked child runs CI over the whole stack and a base push re-triggers it (`we:scripts/readiness/overlap-chain.mjs:53-58`). That is why the small, low-risk row is the cheap one and depth stays at 1.

Skeptic: SURVIVES-WITH-AMENDMENT. "Settings" is not always low-risk (some settings files change drain behavior) and "urgent/emergency" was undefined; folded in as the path-derived class and the operator-flagged emergency above. No statute collision found (we:docs/agent/platform-decisions.md self-approval and drain-owns-every-merge rows are compatible).
Screen: flagged(prio) -> fixed: the fork now rules only the floor; the other cells moved to default settings values.

## Fork 2 — base closed or rejected

*Fork-existence:* the child cannot stay on a base that will never land (`we:scripts/lib/pr-merge-gate.mjs:311` retargets only when the base merges), so something must move it. That is forced; the open question is who decides, and the branches differ on merit: a rejected base may have been rejected for the very lines the child leans on.

Options:

- (a) **A low-risk child rebases onto main automatically only if the rebase is clean AND the child's net diff against main keeps the fingerprint of the delta that was reviewed. Every other case, and every non-low-risk child, goes to the operator.** Consistent with the platform rule of no mandatory human review for safe changes (we:docs/agent/platform-decisions.md self-approval rows) and with the fingerprint test in `we:scripts/conveyor/review-stack-base.mjs:18-22`.
- (b) Always the operator. Safest, slowest; a docs child waits on a human for nothing.

Skeptic: SURVIVES-WITH-AMENDMENT. A low-risk child can still lean on rejected lines, so the auto-rebase needs the clean-rebase plus unchanged-fingerprint test; folded in.
Screen: clear.

## Supported by default (not forks)

- **Settings, each a cascade setting with its source logged** (cascade as in `we:scripts/lib/policy-cascade.mjs`; first home beside `reviewWhileBaseOpen` in `we:scripts/settings/stack.json`): `stack.allowedBaseStates` (matrix), `stack.urgentClasses` (expedite-class, unblocks-others), `stack.smallChildMaxLines` (50), `stack.lowRiskClasses` (cards, settings, docs, from xugqjw1), `stack.maxDepth` (1), `stack.onBaseHeadMove` (restack + delta re-review; the restack half already exists as `prStack.restack` in `we:scripts/settings/pr-stack.json`).
- **Review when the base moves (not a fork).** Restack (existing `stack.onBaseHeadMove`), review the child's own delta only. On a moved base, only the `reviewed-stack` hold marker is re-pointed to the new base head, and only when the child-delta fingerprint is unchanged and the base's new commits touch no file the child delta touches. `review:accepted` is still applied only at collapse, through the existing net-diff carry, so "merge gates are never weakened" (`we:scripts/conveyor/review-stack-base.mjs:14-22`) holds. If the base's new commits touch the child's files, re-review the delta. Skeptic: SURVIVES-WITH-AMENDMENT (the early-label reading was the collision; fixed). Screen: flagged(prio) -> moved here.
- **Free-scope and base files (not a fork).** The stacking rule and the OCCUPIED report cannot both stand, so this is a build. The caller names the intended base PR (`--stack-on=<n>`, because before the lane exists no stack parent is recorded). Free-scope derives the chain from that PR, applies the matrix, and excludes only PR holders in that chain, never agent-registry holders. New work: `excludePr` in `we:scripts/operations/free-scope.mjs:135` is a single number while the CLI takes a list (`we:scripts/operations/free-scope-cli.mjs:36`), so the operation input must become a list. Skeptic: SURVIVES-WITH-AMENDMENT. Screen: flagged(prio) -> moved here.
- **Max depth is a config dimension, not a fork.** 1 now, 2 later. The planner default is 4 (`we:scripts/readiness/overlap-chain.mjs:58`), so the new default is stricter than the planner's.
- **The drain order (base first) is already enforced** by the proof-of-land gate; this card adds no new ordering rule.
- **Guard / merge-path class** is read from the review-stringency list (xugqjw1), not redefined here.

## Edge cases this change must handle

1. **Untrusted text** — the child's size and class are read from the diff and touched paths by code, never from labels or PR body text; gate-feeding settings paths are guard class, including in a mixed low-risk child.
2. **Truncated reads** — an unreadable base state or file list fails closed to "does not stack" and free-scope keeps reporting OCCUPIED.
3. **Shared state files** — settings live in per-feature files under `we:scripts/settings/`; no shared file is edited by two features.
4. **Fail closed** — any unknown base state, unknown class or missing proof gate means no stacking.
5. **Identity scoping** — a stack relation counts only between trusted lane PRs of the same actor, as `we:scripts/conveyor/review-stack-base.mjs:120` already requires.
6. **State over time** — a base that moves or closes after the child opened re-evaluates the cell at that moment (review rule above, Fork 2).
7. **Who wrote it** — an automation's own comments never set an urgent class.

## Acceptance

- [A1] **Executable** — a test that feeds each of the nine matrix cells to the stacking policy and expects the table above, plus a free-scope test that a stack-allowed child is FREE on its base's files and OCCUPIED on a never cell.

## Non-goals

- [N1] This card ratifies the policy only. Epic 6899 owns the four build slices: policy settings and evaluator; free-scope; drain ordered landing, restack and delta re-review; closed or rejected base handling.
