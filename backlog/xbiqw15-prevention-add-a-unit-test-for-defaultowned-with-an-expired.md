---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a unit test for defaultOwned with an expired claim in a temp lockRoot. Longer term, a lint ru… (from web-everything/web-everything#4787 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/orphan-fix-round.mjs:131` — Add a unit test for defaultOwned with an expired claim in a temp lockRoot. Longer term, a lint rule that flags listFixDispatchClaims() calls with no explicit liveOnly option.
2. `we:scripts/conveyor/orphan-fix-round.mjs:185` — Count not-done outcomes as well, for example by posting a distinct 'attempt refused' marker or keeping per-PR failure state, and add a test that N consecutive refusals produce an escalation.
3. `we:scripts/conveyor/orphan-fix-round.mjs:196` — Write the marker before dispatching, or persist the redispatch count in the local fix-claim store. Add a test that a postComment failure still counts toward the cap.
4. `we:scripts/conveyor/orphan-fix-round.mjs:129` — Enable an AST-based lint rule such as `@typescript-eslint/no-floating-promises` to catch floating promises statically.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4787@beecba7f15ea83681c7b5b91dd0f99acdfd069d9

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
