---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4419-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a deterministic documentation check rejecting node we: invocations in executable proof instru… (from web-everything/web-everything#4355 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4419-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:68` — Add a deterministic documentation check rejecting `node we:` invocations in executable proof instructions.
2. `we:backlog/4419-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:75` — Add parameterized malformed-scope tests and a throwing-probe test to the required sibling-smell suite, and verify that removing their guards makes those named tests fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4355@172a7c2321bbb5af16bafb9fa6913f585f6b4dc0

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
