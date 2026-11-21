---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/lib/review-loop/intake.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Bind the reconcile-pass intake reader to each PR's own repo checkout

PR #7313 wires readIntake into we:scripts/conveyor/reconcile-pass.mjs#runReconcilePass with the default git reader from we:scripts/lib/review-loop/intake.mjs#readIntake, which runs git merge-base/diff in process.cwd() for PRs from every constellation repo. For a plateau-app or frontierui PR the head is not in that clone, so the verdict is always unknown (intake-unmeasurable). Harmless while intake.enforce is shadow; under enforce=on it would refuse every non-WE PR. Before enforce=on, resolve a per-repo checkout (or a GitHub-side diffStat) for the intake read, and make the 9 other runReconcilePass test callers inject intakeReader so none can reach live git.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
