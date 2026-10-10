---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/stand-down-disposition.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a shared table-driven 'untrusted author is ignored' test that runs over every exported reader… (from web-everything/web-everything#4758 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/stand-down-disposition.test.mjs:240` — Add a shared table-driven 'untrusted author is ignored' test that runs over every exported reader built on parseOperatorAnswer.
2. `we:scripts/conveyor/__tests__/stand-down-disposition.test.mjs` — Add a deterministic regression containing results both before and after an answer, asserting that only the later results count and that sufficient later attempts trigger exhaustion; cover redispatched and red-again results.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4758@b93d605b8d55b44236b64f9f1280514d338dca48

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
