---
bornAs: xziznha
kind: story
size: 2
status: open
dateOpened: "2026-11-16"
tags: []
---

# codex-direct-task records taskFile, taskSha256 and task head in report and job record

Result report and job record gain taskFile, taskSha256 and the first 200 chars of the task so a job's brief can be traced.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/__tests__/codex-direct-task.test.mjs` asserts taskFile, taskSha256 and a 200-char task head in the result report and job record for both --task-file and --task; fails before, passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to gate, routing or task execution; only trace fields are added.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the 200-char head is stored as a JSON string, never executed.
2. **Truncated reads** — n/a: trace fields only.
3. **Shared state files** — n/a: trace fields only.
4. **Fail closed** — n/a: trace fields only.
5. **Identity scoping** — n/a: trace fields only.
6. **State over time** — n/a: trace fields only.
7. **Who wrote it** — n/a: trace fields only.
