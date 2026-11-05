---
bornAs: xwip7tn
kind: task
status: open
scope: ["we:src/_data/__tests__/backlog-normalize-scope.test.ts", "we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-11-05"
tags: []
---

# Make backlog-normalize-scope corpus sweep hermetic (frozen fixture + scope-shape lint)

we:src/_data/__tests__/backlog-normalize-scope.test.ts line 97 reads the live backlog/ directory, so it fails on unrelated PRs when any open card gains a scope that dispatch refuses (found by the PR 6244 advisory review). Move the corpus sweep into a check:standards or backlog-lint rule that validates scope shape at card-authoring time, and make the unit test use a frozen fixture.

## Acceptance

- [A1] **Executable** — `npx vitest run we:src/_data/__tests__/backlog-normalize-scope.test.ts` passes with a card added under backlog/ whose scope dispatch refuses (fails before, passes after).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing excluded beyond the stated move.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: test-hygiene change, no new input surface.
2. **Truncated reads** — n/a: test-hygiene change, no new input surface.
3. **Shared state files** — n/a: test-hygiene change, no new input surface.
4. **Fail closed** — n/a: test-hygiene change, no new input surface.
5. **Identity scoping** — n/a: test-hygiene change, no new input surface.
6. **State over time** — n/a: test-hygiene change, no new input surface.
7. **Who wrote it** — n/a: test-hygiene change, no new input surface.
