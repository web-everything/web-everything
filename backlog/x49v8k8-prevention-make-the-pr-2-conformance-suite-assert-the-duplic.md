---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/platform-decisions.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Make the PR 2 conformance suite assert the duplicate-before-conflict order and row validation for… (from web-everything/web-everything#7310 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/platform-decisions.md:6212` — Make the PR 2 conformance suite assert the duplicate-before-conflict order and row validation for appendIf. Add that sentence to the statute text now, so the text and the test agree.
2. `we:docs/agent/platform-decisions.md:6206` — Add a check:statute rule that requires each "never", "required" or "refuses" bullet in a store-contract section to cite a conformance test name. Until then, file PR 2 as a hard dependency that lists each guarantee with its test case.
3. `we:docs/agent/platform-decisions.md:6206` — Add a `check:statute` rule or a PR 2 checklist that every sentence in a store-contract bullet maps to a named case in `we:verdict-ledger-store-conformance.mjs`. A conformance-suite coverage test that enumerates contract clauses would be the deterministic gate.
4. `we:docs/agent/platform-decisions.md:6212` — State the evaluation order in the bullet (already-stored event ids first, then compare, then write). Pin it with the planned test 8 under a named case such as 'retry-with-same-event-id-returns-duplicate-not-conflict' in the conformance suite. File a card so PR 2 includes that case.
5. `we:docs/agent/platform-decisions.md:6206` — Add a deterministic preparation check requiring each contract guarantee to reference a repository-qualified test file, named case, observable assertion, and planned or implemented status.
6. `we:docs/agent/platform-decisions.md:6206` — Add a deterministic preparation check requiring each acceptance or behavioral-risk guarantee to reference a repository-qualified test file, named planned case, and observable assertion; implementation checks should verify those cases exist.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7310@9633d145148893de5186c46b4e50a76d7a204cdf

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
