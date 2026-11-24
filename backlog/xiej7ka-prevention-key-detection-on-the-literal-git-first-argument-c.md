---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/push-gate-lint.mjs", "we:scripts/__tests__/push-gate-boundary.test.mjs", "we:scripts/lib/__tests__/push-gate-lint.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Key detection on the literal 'git' first argument (callee-agnostic). Add a completeness cross-che… (from web-everything/web-everything#7420 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/push-gate-lint.mjs:69` — Key detection on the literal 'git' first argument (callee-agnostic). Add a completeness cross-check to the boundary test: any tracked file with a call-argument string literal 'push' preceded by a 'git' literal in the same call must be a detected site or be explicitly listed as a known miss. Add a negative test with a helper named command, execGit or tryGit.
2. `we:scripts/__tests__/push-gate-boundary.test.mjs:48` — Add two fixtures to we:scripts/__tests__/push-gate-boundary.test.mjs passing admit() an entry with status 'allowed' and an entry with an empty reason, each expecting a throw. Where possible, move the allowlist schema check into a dedicated validator function with its own unit test.
3. `we:scripts/__tests__/push-gate-boundary.test.mjs:50` — Add one `it.each` over malformed entries (bad status, empty reason, non-integer or zero sites) against the shared `admit`. Better, move `admit` and an entry validator into `we:scripts/lib/push-gate-lint.mjs` so the schema check is a named, exported unit.
4. `we:scripts/lib/push-gate-lint.mjs:16` — Tokenise the shell string with a split on whitespace and walk the tokens linearly, or use an unambiguous pattern such as `(?:-\S+\s+)*`. Add a bounded-time test with 200 dash tokens. A lint rule such as `eslint-plugin-regexp/no-super-linear-backtracking` would catch the class of defect.
5. `we:scripts/__tests__/push-gate-boundary.test.mjs:57` — Add a parameterized test named 'rejects invalid migration status and missing or short reasons' in we:web-everything/scripts/__tests__/push-gate-boundary.test.mjs, asserting that each invalid field independently makes admit throw.
6. `we:scripts/lib/push-gate-lint.mjs:102` — Add 'ignores process and helper options when classifying argv' in we:web-everything/scripts/__tests__/push-gate-lint.test.mjs, asserting empty results for spawn('git', ['status'], {cwd: dir}) and git('status', {cwd: dir}), with corresponding push calls still detected.
7. `we:scripts/lib/push-gate-lint.mjs:81` — Add a deterministic table-driven negative test covering executable identity and Git subcommand position in we:scripts/__tests__/push-gate-lint.test.mjs.
8. `we:scripts/__tests__/push-gate-boundary.test.mjs:57` — Add parameterized admission rejection tests for absent or incorrect status and absent, empty, or too-short reasons; include these guards in mutation checks.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7420@f2d8960e82f5aab62bbbea54a8516e5c0190c351

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
