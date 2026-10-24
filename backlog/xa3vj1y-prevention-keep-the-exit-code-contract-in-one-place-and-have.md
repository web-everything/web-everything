---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.claude/agents/codex-runner.md", "we:scripts/codex-direct-task.mjs", "we:scripts/__tests__/codex-direct-task.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Keep the exit-code contract in one place and have the agent doc say 'repeat while exit code is 75… (from web-everything/web-everything#5835 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.claude/agents/codex-runner.md:15` — Keep the exit-code contract in one place and have the agent doc say 'repeat while exit code is 75; any other code is terminal'. Optionally add a doc-lint test asserting the runner doc mentions 75.
2. `we:scripts/codex-direct-task.mjs:806` — Decide the gate deadline separately from the Codex run deadline, give it its own named constant, and list it in the PR's 'changed behaviour' section.
3. `we:scripts/codex-direct-task.mjs` — Add the named regression test to the automated suite, exercising stalled production PID probes and asserting the requested deadline plus scheduling tolerance.
4. `we:scripts/codex-direct-task.mjs` — Add a deterministic regression test that stalls the default ps subprocess and asserts the entire wait completes within the requested budget; make the production probes asynchronous and share the remaining deadline.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5835@230e7585f6c043f558cee5152af7952f7fed9329

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
