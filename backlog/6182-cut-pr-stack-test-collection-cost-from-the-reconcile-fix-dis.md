---
bornAs: x09qb14
kind: task
status: open
blockedBy: ["5725"]
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Cut pr-stack test collection cost from the reconcile-fix-dispatch import closure

The `we:scripts/conveyor/__tests__/pr-stack.test.mjs` suite spends roughly 0.5-0.8 s executing its 118 cases and ~4-5 s collecting. Collection is dominated by the import closure of `we:scripts/conveyor/reconcile-fix-dispatch.mjs` (about 0.44 s to import standalone, several seconds under Vitest's transform), which the suite pulls in for just `filterFixesByInFlightScope` and `runReconcileFixDispatch`. Follow-up from card 5725, whose scope lease did not include that module, so it could not show a wall-time gain for this suite.

Profile the closure, then either split the two needed functions behind a small module or make the heavy edges lazy, without changing dispatch behavior. Re-export from the old module so every existing import keeps working.

## Acceptance

- [A1] **Executable** — matched before/after runs of `we:scripts/conveyor/__tests__/pr-stack.test.mjs` through the admitted `npm run test:unit` entrypoint (at least five alternating rounds, same worker count and Node version, queue wait reported separately) show a lower median wall time, with all 118 cases present after card 5725 (its 117 plus the one it added) still passing and no case skipped or deleted.
- [A2] Export identity holds: the old and new import paths return the same functions with the same behavior; the existing reconcile-fix-dispatch suites pass unchanged.

## Non-goals

- [N1] No change to dispatch, claim, scope or stack-hold behavior, and no change to verify selection, worker limits or the admission queue.
- [N2] No blanket module mocks to hide the import cost.

## Edge cases this change must handle

1. **Untrusted text** — n/a: pure module-boundary move; no new text reaches a shell, path or regex.
2. **Truncated reads** — n/a: no `gh`/`git` read is added or changed.
3. **Shared state files** — n/a: no state file is touched.
4. **Fail closed** — keep every existing refusal in the moved functions byte-for-byte; the existing cases are the proof.
5. **Identity scoping** — n/a: keys and ids are unchanged.
6. **State over time** — module-level memo state (hold memo, lazy claim-list import) must still reset between cases as the suite expects.
7. **Who wrote it** — n/a: no trust decision changes.
