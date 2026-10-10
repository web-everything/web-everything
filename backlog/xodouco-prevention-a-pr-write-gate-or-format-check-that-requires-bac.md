---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xxfpvy3-stack-review-while-open.md", "we:scripts/conveyor/pr-stack.mjs", "we:scripts/lib/stack-review-while-open.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs", "we:scripts/lib/__tests__/stack-review-while-open.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — A PR write-gate or format check that requires backlog/*.md files to contain ## Risks and ## Test… (from web-everything/web-everything#4789 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xxfpvy3-stack-review-while-open.md:1` — A PR write-gate or format check that requires backlog/*.md files to contain ## Risks and ## Test plan headings.
2. `we:scripts/conveyor/pr-stack.mjs:15` — A lint rule (e.g., import/no-cycle) that prevents the circular dependency at build time, eliminating the need for an untested dynamic import workaround.
3. `we:scripts/conveyor/pr-stack.mjs:465` — A lint rule or review convention that discourages substituting simple lambda mocks for pure production functions in tests.
4. `we:scripts/lib/stack-review-while-open.mjs:74` — A unit test asserting that PRs targeting `master` are not classified as stacked by `isGithubStacked` when the default branch argument is omitted.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4789@00ceaee77f6449dd4a7b36806e9c01ed4d373f2e

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
