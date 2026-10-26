---
kind: story
size: 3
status: open
dateOpened: "2026-10-26"
scope: ["we:docs/agent/testing.md", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/", "we:scripts/lib/__tests__/"]
tags: [testing, prevention]
---

# Require named tests for process supervisor guarantees

Add a test-plan rule and export-reference check for new library modules so their public entry points and process lifecycle guarantees receive explicit tests. This captures the prevention work owed by the advisory review of web-everything/web-everything#5979 dated 2026-10-26T21:02:37Z. The immediate detached-operation regression cases are added in that PR; this card covers enforcing the same requirements for future libraries.

## Acceptance

- [A1] **Executable** — Add a focused standards-check test with a new library export omitted from all named tests; the check must reject that fixture. A fixture naming and exercising every export must pass. Include alias/re-export and non-function export cases, with an explicit policy for each.
- [A2] The test-plan checklist requires a real spawned command to exit 0 and a nonzero code, with both captured output and persisted terminal status asserted, for every new process-supervising library. CI must select that integration test.
- [A3] The checklist and its focused regression fixtures require hostile-id table tests at every public record reader/writer: traversal, absolute paths, leading flags, empty values, separators, control characters, and Unicode variants. Assert rejection before file reads outside the store or process creation.
- [A4] The checklist requires controlled process listings and signal spies: a live runner with a recorded start time remains running with code 75 when its current start time is unreadable; an observed descendant with a changed identity receives no cleanup signal. A same-identity positive control must receive a signal.
- [A5] The checklist requires delayed child closure after cancellation: persisted state remains running after signaling and after the exit event, and becomes terminal only after close.
- [A6] The checklist requires a filesystem-boundary test for lifecycle publication: the destination retains its complete previous JSON while temporary JSON is written, and replacement occurs through rename. Cover initial and terminal records.

## Non-goals

- [N1] Change detached-operation runtime behavior, promise stronger process identity guarantees, or add a repository-wide coverage percentage.
- [N2] Treat a lexical export reference alone as proof of behavioral coverage; the plan must still name the assertion and observable boundary.

## Edge cases this change must handle

1. **Untrusted text** — Parse source and test names as data; never evaluate exports or execute test text while checking references.
2. **Truncated reads** — Refuse incomplete source or test inventories rather than accepting missing coverage.
3. **Shared state files** — Require atomic publication tests with previous-record assertions at the write/rename boundary.
4. **Fail closed** — A new export with no named behavioral test produces a concrete diagnostic with its module and export name.
5. **Identity scoping** — Pair changed-identity negative tests with same-identity cleanup controls and unreadable-identity fallback cases.
6. **State over time** — Require real completion and cancellation ordering, including the interval between exit and close.
7. **Who wrote it** — n/a: the check reads local source and test files; it does not authorize external writes or infer reviewer identity.
