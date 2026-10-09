---
bornAs: xdv1fpn
kind: story
size: 2
status: active
scaffoldedBy: "fix-4447"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Forward owedTriggers (ci-trigger-owed) from reconcile results through the fix and ci-heal dispatchers into the daemon log

PR 4447 moved never-started required checks out of refusals (check-read-failed) into reconcile-pass owedTriggers, which only formatReport reads. reconcile-fix-dispatch and ci-heal-pr-dispatch return only reconcileRefusalDetails, so the daemon tick log no longer shows such a PR (e.g. plateau-app 217) unless missing-run recovery acts on it. Forward owedTriggers additively through both dispatchers and log one line per trigger in the daemon onTick, plus a daemon-level test that the signal still reaches the log. Prevention: when a signal moves out of an existing result field, grep every consumer and test the daemon-level output still carries it.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
