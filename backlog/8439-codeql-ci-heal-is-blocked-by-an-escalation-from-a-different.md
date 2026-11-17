---
bornAs: x65y7go
kind: story
size: 3
status: active
scaffoldedBy: "fix-5082"
dateScaffolded: "2026-10-13"
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# CodeQL ci-heal is blocked by an escalation from a different heal on the same head

planReconcile's CodeQL heal (queued path, and since PR #5082 the drain-number hold) calls latestCiHealEscalationForHead, which is head-scoped and reason-blind: an earlier red-ci heal's needs-human escalation on the same head refuses the CodeQL repair as ci-heal-escalated. voidNeedsHumanWhenCiGreen skips PRs with codeqlFailure, and under the owed-main-rule hold the head cannot move, so the CodeQL alert waits on a person for as long as the hold lasts. Fix: record the heal reason on the escalation marker and scope the CodeQL heal's escalation check to codeql escalations (keep a loop bound). Also: planCodeqlHeal's escalation handling lacks the waiting-on-system-fix re-arm the red-ci path has. Found by fix-5082 self-review.

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
