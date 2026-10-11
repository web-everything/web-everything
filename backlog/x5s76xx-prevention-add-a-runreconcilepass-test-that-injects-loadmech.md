---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/mechanical-round-cap.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a runReconcilePass test that injects loadMechanicalRoundsSetting and enrichMechanicalRound sp… (from web-everything/web-everything#4770 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-pass.mjs:1375` — Add a runReconcilePass test that injects loadMechanicalRoundsSetting and enrichMechanicalRound spies and asserts when each is called (repoKey we vs other, setting true/false/throwing). Longer term, a coverage gate for newly added injectable seams.
2. `we:scripts/conveyor/mechanical-round-cap.mjs:88` — Add a standards or lint rule that any predicate over thread comments checks the trusted author first, plus a unit test that feeds an oversized adversarial line from an untrusted author. Also bound the length of the attribution line before running the regex, or make the regex linear by anchoring ` via ` once.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4770@5a5390508d71b758535ac20d9d549df6d09943f2

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
