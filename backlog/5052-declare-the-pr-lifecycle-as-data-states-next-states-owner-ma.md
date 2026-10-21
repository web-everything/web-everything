---
bornAs: xgj8yvn
kind: story
size: 3
parent: "3383"
status: open
relatedTo: ["4075", "4282", "4284", "3007"]

dateOpened: "2026-10-04"
tags: []
scope: ["we:scripts/conveyor/pr-lifecycle.mjs", "we:scripts/conveyor/__tests__/pr-lifecycle.test.mjs", "we:scripts/lib/pr-state.mjs", "we:scripts/lib/pr-state/__tests__/pr-state.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
---

# Declare the PR lifecycle as data over ledger state (states, next states, owner, max time, label rendering)

The lifecycle table, ledger derivation and migration adapter have shipped; the remaining contract is what the single owner means when a human-held PR also has failing CI. Complete that ownership contract against the existing reconcile outcomes, retaining a provider-neutral state table and label rendering as output. The proposed approach is an accountable coordinator per state, with executable recovery actions remaining in reconcile; it requires the ownership choice below before implementation. Size 3 covers the table/derive contract and cross-contract tests, not a new lifecycle engine.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/pr-lifecycle.test.mjs`: add a regression requiring an explicit owner-role contract (proposed `ownerRole: coordinator|operator`) on every row, with coordinator semantics for HUMAN-HOLD-CI-RED. This fails against the current table, which only declares owner names. If the state-splitting option is selected, replace this assertion with distinct owner/state cases before build.
- [A2] A table-driven comparison with reconcile covers ordinary red required CI (ci-heal), review-gate-only red (no ci-heal), exhausted heal budget (operator escalation), restored green CI while a human hold remains, and merged/closed PRs. Each case yields one declared lifecycle state and an accountable owner without implying that owner executes every recovery action.
- [A3] Preserve the existing manifest/resident/operator owner validation, declared next-state edges, positive nonterminal time budgets and label renderings. Derivation remains repo/PR/head scoped and labels remain output; contradictory or incomplete evidence cannot yield READY-TO-MERGE.
- [A4] Keep the label migration adapter until its authority migration actually completes; add a source/import regression preventing new consumers from bypassing the ledger derive. Do not treat #4281 as an unmet blocker: its card is resolved and the substrate is present.

## Non-goals

- [N1] No central orchestrator, new runner, automatic human approval, or changes to CI-heal budgets.
- [N2] No authority flip or label-adapter deletion as part of this ownership clarification.

## Edge cases this change must handle

1. **Untrusted text** — Event text and label strings cannot invent state/owner identifiers or inject commands; the table supplies the vocabulary.
2. **Truncated reads** — Incomplete ledger/fact reads yield a held state, not a green merge state; preserve existing unreadable-ledger behavior.
3. **Shared state files** — n/a: this table and derive are pure; no new shared state writer is introduced.
4. **Fail closed** — Unknown scope, malformed rows and derivation failure retain a named hold; no owner mapping may clear it.
5. **Identity scoping** — Repo, PR and head bind review/check evidence; identical PR numbers across repos and old-head approvals remain isolated.
6. **State over time** — Test head replacement, check recovery, exhausted retry budget, ruling arrival and terminal closure; stale evidence cannot revive readiness.
7. **Who wrote it** — Preserve upstream ledger provenance checks; a label or comment claiming acceptance is not new authority.

## Grounding

- we:scripts/conveyor/pr-lifecycle.mjs:18 already exports the table; :36 assigns HUMAN-HOLD-CI-RED to ci-red-recovery-watch; :51 explicitly includes resident owners and the operator.
- we:scripts/conveyor/__tests__/pr-lifecycle.test.mjs:17 validates owners, :22 validates edges, and :37 pins the human/red state to that watcher.
- we:scripts/lib/pr-state.mjs:86 guards ledger derivation, :125 renders the lifecycle output and :140 implements labelsToLedgerState.
- we:scripts/conveyor/__tests__/reconcile-core.test.mjs:818 dispatches ci-heal for human-held/red CI, :824 excludes review-gate-only failures and :832 escalates exhausted healing.
- Commit 2a786ea24e delivered the table/derive slice; we:backlog/4281-pr-ledger-slice-2a-derive-per-pr-state-from-the-webhook-even.md:6 is resolved. The former blockedBy edge is therefore removed.

## Open questions

Does owner mean (a) one accountable coordinator, with reconcile choosing an executor/escalation, or (b) the exclusive next-action executor, requiring HUMAN-HOLD-CI-RED to split into healable, review-gate-held and exhausted states? **Pick (a)**: it preserves the existing phase vocabulary and separates responsibility from execution, but must document the watcher-to-operator escalation explicitly. Option (b) gives a more literal dispatch map at the cost of new states/transitions. This preparation does not ratify either meaning.
