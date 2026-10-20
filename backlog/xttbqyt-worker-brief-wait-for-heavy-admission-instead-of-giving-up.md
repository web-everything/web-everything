---
kind: task
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Worker brief: wait for heavy-admission instead of giving up

Four workers on 2026-10-20 stopped with 'heavy-command admission deferred (exit 75), host load ~40/12' and left tests unrun. we:scripts/worker-brief.mjs should tell workers: tests go through node we:scripts/readiness/heavy-admission.mjs run -- ...; on exit 75, either wait via the sanctioned bounded wait (if the agent can) or hand back the exact lane, sha and command to the orchestrator. Never stop silently, never sleep-loop.

## Acceptance

- [A1] **Executable** — a test on the worker-brief output asserts the printed block names `node we:scripts/readiness/heavy-admission.mjs run --` as the way to run tests, and states the exit-75 rule. It fails before this lands and passes after.
- [A2] **Must** — the brief says: on exit 75, either wait through the sanctioned bounded wait (only if this agent can use it) or hand back the exact lane, sha, and command to the orchestrator in the final report.
- [A3] **Must** — the brief forbids stopping silently, forbids a sleep loop, and forbids running the tests outside the gate to get around the deferral.
- [A4] **Must** — a worker that hands back must say tests are NOT run; the brief never lets "deferred" read as "passed".
- [A5] **Executable** — the brief text and the heavy-admission exit-code meaning are checked together in one test, so a changed exit code breaks the test.

## Non-goals

- [N1] Does not change heavy-admission itself (cap, queue, or exit codes).
- [N2] Does not add a new waiting mechanism; it points at the existing bounded wait.
- [N3] Does not make the orchestrator re-dispatch handed-back work; that is a separate card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the brief is static text from the repo; no external input is put in it.
2. **Truncated reads** — the handback names lane, sha and command in full; a short or cut-off report must still carry the sha and command, so they go first in the report.
3. **Shared state files** — n/a: the brief only prints text and writes no state.
4. **Fail closed** — an unknown exit code from the gate is treated as "not run", and the worker hands back; never as pass.
5. **Identity scoping** — the handback names the lane and sha of THIS worker, so the orchestrator cannot confuse it with a sibling's.
6. **State over time** — host load changes; the handback sha may be stale when the orchestrator retries, so the orchestrator re-checks the lane head against the sha before running.
7. **Who wrote it** — the brief is read by Claude and Codex workers alike; the wording does not assume a tool only one of them has.
