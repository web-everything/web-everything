---
bornAs: xuj2m36
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# A stand-down whose red is inherited from the stack base routes to the base fixer, not the operator

Held finding 234 (2026-10-11). Live #4880 07:02 ET: "verify red is inherited from bottom PR #4797 ... a restack may not edit bottom files" stood down asking a human. #4941 re-arms the ci-heal when the base moves; this card covers the stand-down route. Fix: when the failing check cause is in a file owned by the stack base (net-diff attribution), post a send-back/fix request on the base PR with the evidence, mark the child waiting-on-base #N, auto-restack when the base pushes; never a human stand-down. Also find why #4797 CI passed while the local multi-repo-checks lint failed, and align CI with the local gate.

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
