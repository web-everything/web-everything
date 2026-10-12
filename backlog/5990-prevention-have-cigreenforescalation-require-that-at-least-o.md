---
bornAs: x1ep1g3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-heal-verdict-recheck.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/__tests__/ci-heal-verdict-recheck.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Have ciGreenForEscalation require that at least one check was actually evaluated (green.length 0)… (from web-everything/web-everything#5033 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-heal-verdict-recheck.mjs:78` — Have ciGreenForEscalation require that at least one check was actually evaluated (green.length > 0). Add a regression test with requiredChecks=['review-gate'].
2. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:496` — Record the red or causing check names in the needs-human escalation marker, and only void when every recorded check is now green. Add a test that a needs-human escalation naming a non-required check is preserved. Capture this as a backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5033@a9e1ea28455d5f460db2ab7d2c3cb958ab8aa59e

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
