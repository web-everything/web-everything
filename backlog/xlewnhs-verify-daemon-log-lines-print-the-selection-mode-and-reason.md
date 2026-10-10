---
kind: story
size: 1
priority: high
status: resolved
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib/verify-selection-log.mjs", "we:scripts/operations/coroner-extract.mjs"]
dateOpened: "2026-10-10"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Verify daemon log lines print the selection mode and reason

The verify daemon's dispatch line omitted whether since-last-green (#4732) or whole-PR selection ran and why; the mode went only to the gate's own stderr, so 'is incremental verify working?' could not be answered from the daemon log. Print mode=<since-last-green|pr|full|explicit> reason=<...> files=<n> tests=<n> on the dispatched gate's selection and verdict lines (copied into the daemon log), and have the coroner count the modes.

## Acceptance

- [A1] **Executable** — `npm run test:unit` on we:scripts/lib/__tests__/verify-selection-log.test.mjs — selection and verdict lines carry mode/reason/files/tests and parse back from the daemon-log copy.


## Non-goals

- [N1] No we:scripts/conveyor/verify-dispatch.mjs change: the lines ride the existing `⚠ verify-lane:` notice channel, so the in-process and detached-job (#4135) dispatch modes both carry them.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the reason is one-lined, capped at 200 characters and JSON-quoted.
2. **Truncated reads** — the dispatcher drains the child's stderr file on exit, so the final verdict line is read.
3. **Shared state files** — n/a: stderr lines only; no marker change.
4. **Fail closed** — n/a: logging only; a write failure never changes the verdict.
5. **Identity scoping** — only a daemon-dispatched run (`--run-id`, verify mode) prints the lines.
6. **State over time** — a run that exits before selection prints mode=unresolved.
7. **Who wrote it** — n/a: printed by the gate process itself.
