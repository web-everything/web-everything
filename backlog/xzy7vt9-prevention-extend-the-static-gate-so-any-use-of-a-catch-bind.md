---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/review-loop-cli-error-class.test.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Extend the static gate so any use of a catch binding in we:scripts/operations/review-loop-cli.mjs… (from web-everything/web-everything#7469 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/review-loop-cli-error-class.test.mjs:152` — Extend the static gate so any use of a catch binding in we:scripts/operations/review-loop-cli.mjs other than as an argument to describeErrorClass or classifyErrorClass fails (AST rule), or add one thrown-secret test per catch site.
2. `we:scripts/operations/review-loop-cli.mjs:628` — Add a boundary test requiring the output to name the debug log location (or say it was not written), and give authored refusals a typed error with a fixed safe message.
3. `we:scripts/operations/review-loop-cli.mjs:581` — Add table-driven negative cases to classifyErrorClass tests (for example a .json path expecting `unknown`) and anchor the pattern to parse-error phrasing or SyntaxError.
4. `we:scripts/operations/__tests__/review-loop-cli-error-class.test.mjs:153` — Add a deterministic check that every catch binding in this file is used only as an argument to describeErrorClass (AST lint rather than a `.message` regex), or a table-driven test that throws a token-bearing error through each of the five sites and asserts the token is absent.
5. `we:scripts/operations/review-loop-cli.mjs:604` — Add a case to the injected-openSync test that swaps in a symlink to a 0600 target just before open and asserts the target is unchanged.
6. `we:scripts/operations/review-loop-cli.mjs:572` — File the follow-up card if it is not already filed: pass outcome errors and effect reasons through the classifier or redactor in this CLI, with an end-to-end test where a sink returns or throws a token-bearing error and stdout is asserted clean. Until then, narrow the comment to caught errors.
7. `we:scripts/operations/review-loop-cli.mjs` — Use a nonblocking open before validating the descriptor, and add a timeout-bounded subprocess regression test that substitutes a real FIFO before open; run it in the standard test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7469@248186f7ebd31434852202cd2f4e8963c4343efe

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
