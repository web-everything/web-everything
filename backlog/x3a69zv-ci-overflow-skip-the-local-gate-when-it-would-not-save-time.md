---
kind: story
size: 3
parent: "4305"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/pr-land.mjs", "we:scripts/readiness/heavy-queue-projection.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# CI overflow: skip the local gate when it would not save time

Held item 207 (session 2026-10-10; operator OK; build right after the admission fix). Operator: "we already decided to push early, so local tests are mostly a time-saving measure; if not saving time, no point." Push-before-gate is live (#4771). Rule: if projected local wait + run time (heavy-queue projection) > expected CI time for this PR's suites (rolling median), skip the local run, push, and treat CI green on that exact head as the verification (the pr-land finish-guard accepts CI-green-at-head as an alternative to the local marker). Settings via cascade: `verify.localGate: always | when-faster | never` (default when-faster), margin minutes; log the decision and both estimates per gate so the coroner can compare. Also update the fixer brief.

## Acceptance

- [A1] **Executable** — tests: projected local > CI + margin skips the local gate; otherwise it runs; finish-guard accepts CI green at the exact head only.
- [A2] **Live** — one gate log line with both estimates and the decision; a skipped-gate PR lands on CI green.

## Non-goals

- [N1] Weakening any merge gate: CI still guards every merge.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: numbers only.
2. **Truncated reads** — No projection or no CI history -> run the local gate (today's behaviour).
3. **Shared state files** — Reads the heavy-queue projection; writes only its own log line.
4. **Fail closed** — Any estimate error -> local gate runs.
5. **Identity scoping** — CI green must be on the exact head sha.
6. **State over time** — Rolling median over recent runs; stale history ignored.
7. **Who wrote it** — The decision log names the setting's source layer.
