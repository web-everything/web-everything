---
bornAs: x8saqsk
kind: story
size: 3
status: active
scaffoldedBy: "fix-4897"
dateScaffolded: "2026-10-11"
scope: ["we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# ci-heal probation-worker launch ignores Claude-only routing (main-fix, round 3+)

On a Claude-only fix-executor decision (main-fix, stronger-model rung, round 3+), createRoutedCiHealDispatch keeps the existing provider routing, so routeAvailableCiHeal/decideDispatchRoute can still pick a probation worker (codex/antigravity) for the heal; the Claude-only reason never reaches that router. Decide whether Claude-only reasons should exclude probation workers for ci-heal (round 1 of PR #4897 required leaving provider routing intact for every Claude outcome, so this is a policy call). Found by the PR #4897 round-3 fixer self-review.

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
