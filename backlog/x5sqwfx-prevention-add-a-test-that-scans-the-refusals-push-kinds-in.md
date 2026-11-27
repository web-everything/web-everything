---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a test that scans the refusals.push kinds in we:reconcile-fix-dispatch.mjs. Each kind must ap… (from web-everything/web-everything#7551 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/orphan-fix-round.mjs:254` — Add a test that scans the refusals.push kinds in we:reconcile-fix-dispatch.mjs. Each kind must appear in either PRELAUNCH_REFUSALS or an explicit AMBIGUOUS_REFUSALS set, so a new kind forces a decision. File a backlog item for this.
2. `we:scripts/conveyor/orphan-fix-round.mjs:330` — Add a test case 'same-pid claim with unknown token holds for inspection' to the claim classification table, and mutation-check the `activeAttemptClaims.has` term.
3. `we:scripts/conveyor/orphan-fix-round.mjs:383` — Keep a fixed, path-free `reason` for anything passed to `buildOrphanGuardComment`, and send the raw `e.message` only to `row.result`/logs. Add a test that forces an unreadable ledger and asserts the posted comment body has no path separators or `orphan-redispatch-attempts`. A lint on `buildOrphanGuardComment` inputs would be a cheap gate.
4. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs:1225` — Test each conjunct of a liveness or identity predicate in its own row, or use a property-style table generated from the list of required fields. A mutation-testing gate on the `busy` predicate would catch this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7551@d65cd50ce97457b8c7212ce618972f2cb98c66c4

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
