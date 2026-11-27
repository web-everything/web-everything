---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/agent-launch-structure.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Parametrise the import-as fixture over both specifiers, node:child_process and child_process. (from web-everything/web-everything#7577 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/agent-launch-structure.test.mjs:19` — Parametrise the import-as fixture over both specifiers, `node:child_process` and `child_process`.
2. `we:scripts/__tests__/agent-launch-structure.test.mjs:1` — Add a documented-gap test with `it.fails` or an explicit expectation of 0 for identifier-alias and promisify forms, so a later slice flips it. Also list the gaps in the header comment.
3. `we:scripts/__tests__/agent-launch-structure.test.mjs:1` — Add one fixture where a local `run` is rebound after being aliased and still counts, labelled as an intentional over-approximation.
4. `we:scripts/__tests__/agent-launch-structure.test.mjs:13` — Add a negative or known-gap test table. It would list the undetected forms (let, chained alias, bind, template element access, re-export) with an explicit comment. Better, move the real boundary to a deterministic gate such as a ban on importing child_process outside an allowlisted wrapper, via an ESLint no-restricted-imports or check:standards rule.
5. `we:scripts/__tests__/agent-launch-structure.test.mjs:2` — Add the named shadowing regression test to the existing test suite so changing that behavior deterministically fails a check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7577@471c6b13efd70a403e0584b9e78309c922785104

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
