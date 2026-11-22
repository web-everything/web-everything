---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/owed-fix-recovery.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/owed-fix-recovery.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a test asserting that recoverOwedFixes leaves non-repair rows (ci-timeout-rerun, promote-draf… (from web-everything/web-everything#7336 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/owed-fix-recovery.mjs:88` — Add a test asserting that recoverOwedFixes leaves non-repair rows (ci-timeout-rerun, promote-draft) untouched for a parked or draft PR. Broader option: a contract test that the recovery wrapper's output differs from plan(input) only in rows of the kinds it owns.
2. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:148` — Add table-driven cases for each referralHold variant (operator, same-head, send-back, resume) asserting recovery admitted or refused.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1978` — Add a wiring test per consumer that asserts the `recoverOwedFixes` option presence and `kinds` under dryRun and live, then file it as a backlog card.
4. `we:scripts/conveyor/owed-fix-recovery.mjs` — Add the multi-tick regression and a mutation check that moves reservation persistence after successful release; the named regression must fail.
5. `(no file cited)` — Require each numbered Acceptance item to reference a named verification and evidence, including checks such as 'babysit follow-up card exists' and 'live recovery on #7307 or #7179'.
6. `we:scripts/conveyor/owed-fix-recovery.mjs:198` — Reserve both required head-read slots before saving retryAt or releasing claims, and gate this with a deterministic mixed-batch regression asserting dispatch on the next tick without premature escalation.
7. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs` — Parameterize the recovery lifecycle regression over explicit fix and ci-heal rows and their corresponding consumer kinds.
8. `(no file cited)` — Require each numbered acceptance item to reference a named test or named operational check with recorded evidence, including 'babysit follow-up card exists' and 'live owed-fix recovery on #7307 or #7179'.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7336@7080d6f53c9c646cb5bb9a62e4852eb00ad11f57

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
