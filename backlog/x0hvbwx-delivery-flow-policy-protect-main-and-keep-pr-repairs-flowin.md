---
kind: epic
parent: "3383"
status: open
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [policy, drain, ci, main-red, heavy-admission, dispatch]
---

# Delivery-flow policy: protect main and keep PR repairs flowing, every rule a configurable key

Main protection and delivery-flow rules, each one a configurable policy key under
`config-extends-platform-default` (`we:docs/agent/platform-decisions.md:1684`), with safe defaults.
Operator approved 2026-10-03: "Do as suggested", "Again, should be policy with configurable", and "Ok" to the
overlap-override and heavy-queue items.

## Why (2026-10-03)

- **Main went red** with 270 `check:standards` errors. The merge of PR #3176 (`bc9db934c`) put a soak
  citation outside the drain's rewrite scope. The drain's JIT numbering then refused
  (`we:scripts/lane-drain.mjs:840-875`), but the drain never read the refusal
  (`we:scripts/merge-ai-prs.mjs:5655`). 282 cards stayed un-numbered on main. The stranded-hash rule
  hard-errors on main but only warns on PRs (`we:scripts/check-standards.mjs:774`). Codex's fix is open
  PR #3788; this epic does not repeat it.
- **While main was red,** CI heals on every PR were refused and PRs sat needs-human. The drain kept merging,
  because its red-main freeze (`we:scripts/merge-ai-prs.mjs:5858-5884`) only fires on a marker nothing
  raises automatically.
- **Overlap overrides:** fix jobs were sent onto open PR #3507's files about five times. Each one cost #3507
  another conflict-fix and review round.
- **Heavy queue:** #3507's conflict-fix verify waited behind three new-card builds holding every heavy slot,
  one for 28 minutes. The queue is first come, first served
  (`we:scripts/readiness/heavy-admission.mjs:853-867`).

## Four ways main breaks, and the story for each

| Way main breaks | Story | Key, default |
| --- | --- | --- |
| (1) A check behaves differently on main than on a PR | #2940 (re-aimed) | `prCi.mainStateParity`, `on` |
| (2) The drain merges PRs one after another without re-testing against the newest main | #xi8vgqq | `mergeGate.recheckWhenMainMoved`, `if-older-than-N-min` (plus `recheckMaxAgeMin`, 30) |
| (3) A CI heal turns a PR green without fixing the cause | #2940 (a heal is judged by the same post-land rule) and #xca0u65 (no landing on a red main) | as above |
| (4) A drain step stops silently, with no alert | #xq4p21a | `drain.onStepRefusal`, `alert` |

Also: #xca0u65 for `mergeGate.onMainRed` (`halt`); #x5qhw83 for `dispatchGate.overlapOverride` (`off`); and
#xkpbs7b for `heavyQueue.priority` (`repairs-first`) and `heavyQueue.reservedForRepairs` (1, borrowable after `heavyQueue.reservedBorrowAfterMin`, 10).

## Stories and order

1. #xcs4nce: the policy keys, defaults, loader and policy-event journal. Everything else is blocked by it.
   Start after PR #3789 lands, because it edits the same config files.
2. #xq4p21a: the silent-drain-step alert, plus the health probe for the journal. Start after PR #3788 lands.
3. #2940: PR-side parity, with a dry run of the post-land numbering.
4. #xi8vgqq: re-check before merge when main moved. It also adds the tested-main-SHA helper and the one-line
   CI step that records it.
5. #xca0u65: halt on red main, and the `mainState` snapshot section. Blocked by #xi8vgqq too, because its
   exemption uses that helper (a run's tested main SHA, not its start time).
6. #x5qhw83: the open-PR overlap gate with a logged override. Also blocked by #xq4p21a, for the probe.
7. #xkpbs7b: repairs-first heavy queue.

Stories 2, 4 and 5 (#xq4p21a, #xi8vgqq, #xca0u65) all edit `we:scripts/merge-ai-prs.mjs`. The conveyor's `scope-vs-open-prs` hold
(`we:scripts/conveyor/build-dispatch-policy.mjs:271-274`) runs them one at a time automatically, so they carry
no artificial blocker edges.

**For the WIP page's high-alert band:** read `machineHealth.sections.mainState` (from `sections.mainState` in
`we:scripts/operations/run.mjs live-state --json`), added by #xca0u65. The band itself is a plateau-app follow-up.

No story touches open PR #3507's files.

## Done when

1. Every story is resolved.
2. `node we:scripts/lib/delivery-policy.mjs --json` shows every key of the keys table in story #xcs4nce (nine
   today), checked by a test that compares the output's flattened `dimension.field` paths to the defaults constant's.
3. Each story's replay of its 2026-10-03 failure passes on main.
