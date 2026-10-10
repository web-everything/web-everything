---
bornAs: xtwu8l0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs", "we:backlog/5734-fixer-pushes-before-its-local-gate-fix-pushbeforegate-while.md"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a card-lint rule that every 'Edge cases this change must handle' item must cite a named test,… (from web-everything/web-everything#4771 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs:1` — Add a card-lint rule that every 'Edge cases this change must handle' item must cite a named test, as item 4 does ('merge-site reread refuses an unreadable fix claim store'). Items 2 and 3 do not.
2. `we:backlog/5734-fixer-pushes-before-its-local-gate-fix-pushbeforegate-while.md` — A PR lint gate (`check:standards`) that parses Markdown backlog cards to enforce the presence of required structural headings like 'Risks' and 'Test plan'.
3. `we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs` — A coverage-checker requirement for new `catch` blocks or explicit mapping of all edge cases to tests during PR authoring.
4. `we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs` — Test coverage minimums enforcing paths where mocked IO operations return failure states.
5. `we:backlog/5734-fixer-pushes-before-its-local-gate-fix-pushbeforegate-while.md` — A deterministic pre-commit hook or PR lint rule that rejects backlog cards lacking literal 'Risks' and 'Test plan' headings.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4771@ca1dc6ca1c94cc7ce5c15892f2333a910a422237

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

## Also raised by

- Also raised by web-everything/web-everything#4810 (finding 1: `we:backlog/xz2yynk-every-daemon-tick-is-schedule-only-async-job-model.md` — A lint rule enforcing the presence of 'Risks' and 'Test plan' headings in backlog cards.)
