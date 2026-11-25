---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/operations/__tests__/review-loop-cli-error-class.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Extend the static test to also ban String(e), {e} and {error} interpolation in output strings. Ad… (from web-everything/web-everything#7469 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-loop-cli.mjs:475` — Extend the static test to also ban `String(e)`, `${e}` and `${error}` interpolation in output strings. Add one throwing-reader test per remaining catch site.
2. `we:scripts/operations/__tests__/review-loop-cli.test.mjs:2362` — Set `REVIEW_LOOP_CLI_DEBUG_LOG` to a temp path in a file-level `beforeAll`/`afterAll` in the test file, or default it in the test setup.
3. `we:scripts/operations/__tests__/review-loop-cli-error-class.test.mjs:155` — Add a check:standards rule that flags any caught identifier (`catch (x)`) used inside a template literal or `String()` outside `describeErrorClass`, or add a no-restricted-syntax lint on `catch` bindings.
4. `we:scripts/operations/review-loop-cli.mjs:608` — Add a table-driven test that forces each exported or injectable catch site to throw a Bearer-bearing error and asserts the output contains no token. File it as a backlog item.
5. `we:scripts/operations/__tests__/review-loop-cli.test.mjs:2362` — Set `REVIEW_LOOP_CLI_DEBUG_LOG` to a temp path in a shared `beforeEach`/`afterEach` for this suite, or add a vitest setup that points HOME at a temp dir.
6. `we:scripts/operations/review-loop-cli.mjs:599` — Skip debug logging when HOME is unset, or use `os.homedir()` and refuse a relative path. Add a test for the unset-HOME case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7469@178d0b4ad11ac45ff65237fa45acd3bf3ec273f5

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
