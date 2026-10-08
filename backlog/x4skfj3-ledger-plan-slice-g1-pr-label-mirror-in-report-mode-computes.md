---
kind: task
parent: "2405"
status: open
scope: ["we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Ledger plan slice G1: pr-label-mirror in report mode computes the derived-vs-live label add/remove set and writes nothing

Slice G1 of the verdict-ledger plan. The mirror diffs derivePrState labels against live labels for every open PR and lists the exact add and remove set per PR. Report only: it never writes a label.

## Done when

1. **Executable** - `npx vitest run we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs` passes: a fixture dry run lists the exact add and remove set per PR, an unreadable PR is skipped (never scored), and the source holds no label-write call.
2. **Executable** - `node we:scripts/conveyor/pr-label-mirror.mjs --json` on the live open PRs prints the add and remove sets and makes zero `gh` writes.

## Edge cases this change must handle

1. **Untrusted text** - n/a: label names are only compared and printed; PR titles are never printed.
2. **Truncated reads** - an unreadable ledger or unreadable GitHub facts mark the PR `unreadable` and plan nothing for it.
3. **Shared state files** - n/a: reads the ledger, writes nothing (no run record in G1).
4. **Fail closed** - report only: a crash plans no change; the CLI exits 2 on a failed PR list.
5. **Identity scoping** - the ledger rows are scoped to the repo and PR number by the derive.
6. **State over time** - n/a: a single point-in-time report; the run history is slice F.
7. **Who wrote it** - n/a: G1 reads label authorship nowhere (label-input is slice K).
