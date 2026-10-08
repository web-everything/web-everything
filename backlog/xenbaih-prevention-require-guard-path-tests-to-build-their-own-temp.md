---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/dispatch-bg-isolation.test.mjs", "we:backlog/xl5reby-dispatched-workers-never-load-the-repo-pretooluse-guards-wir.md", "we:scripts/lib/dispatch-bg-isolation.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Require guard-path tests to build their own temp workspace fixture, with no environment-condition… (from web-everything/web-everything#4449 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/dispatch-bg-isolation.test.mjs:176` — Require guard-path tests to build their own temp workspace fixture, with no environment-conditional assertions. A lint rule could flag `expect` calls inside `if (existsSync(...))` in test files.
2. `we:backlog/xl5reby-dispatched-workers-never-load-the-repo-pretooluse-guards-wir.md:16` — A check:standards rule that fails when a card landing as done still contains `TODO:` placeholders.
3. `we:scripts/lib/dispatch-bg-isolation.mjs:186` — Add a check:standards rule or a test that every consumer of isolateDispatchSession either reads `.hooks.ok` or logs through a named sink. Alternatively, have isolateDispatchSession emit a warning event on `!hooks.ok`.
4. `we:scripts/lib/__tests__/dispatch-bg-isolation.test.mjs:175` — Build a temp fake workspace (`<tmp>we:/webeverything/scripts/guard-bash.mjs` copied or symlinked) so the deny assertion always runs. Add a lint rule against `if (existsSync(...)) expect(...)` conditional assertions in tests.
5. `we:scripts/lib/dispatch-bg-isolation.mjs:106` — Add a required parameterized unit test using the existing fileUrl and exists injection points to cover both primary names, lane selection, and the documented fallback; assert exact resolved roots and hook commands.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4449@50bb7996c476c89609848da3853adb31fa89f8fd

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
