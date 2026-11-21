---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-state/holds/verdict.mjs", "we:scripts/operations/operator-controls-io.mjs", "we:scripts/lib/pr-state/holds/__tests__/verdict.test.mjs", "we:scripts/operations/__tests__/operator-controls-io.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a standards or lint rule, or a required-arg test, that a binding predicate must receive an ex… (from web-everything/web-everything#7274 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-state/holds/verdict.mjs:14` — Add a standards or lint rule, or a required-arg test, that a binding predicate must receive an explicit head or an explicit opt-out token rather than `undefined`. Or file a card to make an unknown head fail closed.
2. `we:scripts/operations/operator-controls-io.mjs:143` — Add a test in `we:operator-controls.test.mjs` that changes the context between plan and sink and asserts a throw and no child call. A review-lens checklist item, 'each new refusal branch has a negative test', would also catch this class.
3. `we:scripts/lib/pr-state/holds/verdict.mjs:14` — For a row that carries headSha, deny when `head` is not a full SHA. Keep the permissive path only for rows without headSha. Add a derivePrState test with a missing head fact. A lint rule against optional security-relevant parameters with a permissive default would also catch this class.
4. `(no file cited)` — Add an acceptance-validation gate requiring every acceptance item to reference a named test and, for live proofs, its recorded result.
5. `(no file cited)` — Add an acceptance-to-test manifest gate requiring each acceptance item to identify a named test and, for live proofs, a recorded result; this guard remains to be filed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7274@34b73b98c48ccec1f78b889e3266de7a6b1dc01c

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
