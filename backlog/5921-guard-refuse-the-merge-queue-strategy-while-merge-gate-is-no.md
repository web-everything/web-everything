---
bornAs: xn92q79
kind: story
size: 3
status: open
scope: ["we:scripts/lib/merge-gate-ci.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-12"
tags: []
---

# Guard: refuse the merge-queue strategy while merge-gate is not in enforce

With mergeDelivery.strategy github-merge-queue, the drain's merge-time gates run only in the required merge-gate CI check. If that check is in shadow (the standard default in we:scripts/lib/merge-gate-ci.mjs), it passes with SHADOW would HOLD and the queue merges PRs the drain would hold. Today only the merge-queue switch runbook (we:docs/agent/merge-queue-switch.md, a dry-run read-back before the ruleset PUT) checks this. Add a lasting guard: the merge-gate run itself (it knows its real mode on GitHub) fails, or the drain refuses to enqueue, when the strategy is github-merge-queue and the resolved mode is not enforce, with a unit test of the pairing. Also add a check:standards rule that each ruleset JSON under we:scripts/rulesets/ has a pinning test. Owed by the PR #4950 round-5 advisory review.

## Acceptance

- [A1] **Executable** — a unit test in `we:scripts/lib/__tests__/` resolves strategy `github-merge-queue` with merge-gate mode `shadow` and expects the guard to refuse (fail the merge-gate run, or refuse the enqueue); with `enforce` it passes.
- [A2] check:standards fails when a JSON under `we:scripts/rulesets/` has no test that reads it.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the standard merge-gate mode or apply the merge-queue ruleset.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads settings values from an allowed list, not free text.
2. **Truncated reads** — an unreadable settings layer counts as not enforce for this guard (refuse).
3. **Shared state files** — n/a: reads settings only, writes nothing.
4. **Fail closed** — any doubt about the mode refuses the queue path; it never falls back to merging.
5. **Identity scoping** — the mode is read where it really applies (the merge-gate run on GitHub sees repo and organization `vars`); a local read alone is not trusted.
6. **State over time** — the mode can change after the switch; the guard runs on every merge-gate run / drain pass, not once.
7. **Who wrote it** — n/a: settings come from main, not from a PR's diff (merge-gate scripts are read from main).
