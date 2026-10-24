---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/pr-merge-gate.mjs", "we:scripts/conveyor/already-landed-watch.mjs", "we:scripts/prune-landed-lanes.mjs"]
scaffoldedBy: "fix-5762"
dateScaffolded: "2026-10-24"
dateOpened: "2026-10-24"
tags: []
---

# Stacked-PR orphaning outside card groups: drain land ignores an incomplete stacked listing; already-landed-watch closes without retargeting

PR #5762 (round 17) made `retargetStackedPrs` report `listed:false` when the stacked-PR listing failed, was not an array, filled gh's default 30-row page, or had a row without a number, and made the card-group source close refuse on it. The operator ruled that existing callers keep their behaviour, so two same-class paths remain. The drain's pre-land retarget ignores `listed` and still merges with branch delete, which can close an unlisted child. `already-landed-watch` closes an already-landed PR with no stacked-PR listing or retarget at all. `prune-landed-lanes` lists with `--limit 200` and no full-page check.

## Acceptance

- [A1] **Executable** — a drain wiring test whose stacked listing throws asserts the land is deferred (bounded retries, then an operator-visible note), and an `already-landed-watch` test with a stacked child asserts the child is retargeted before the close, or the close is skipped when the listing is incomplete.

## Non-goals

- [N1] The card-group source close: PR #5762 already fails closed there.

## Edge cases this change must handle

1. **Untrusted text** — n/a: PR numbers only, passed as argv.
2. **Truncated reads** — a full listing page (30 default, 200 for prune) counts as incomplete.
3. **Shared state files** — n/a: no state file.
4. **Fail closed** — an incomplete listing defers the land or close; a bounded retry count then reports to the operator.
5. **Identity scoping** — the listing is scoped by `--repo` and `--base <headRef>`; a missing headRef counts as incomplete.
6. **State over time** — a deferred land retries next pass; it must not wait forever.
7. **Who wrote it** — n/a: no markers read.
