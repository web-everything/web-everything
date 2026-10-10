---
kind: task
status: active
scaffoldedBy: "fix-4631"
dateScaffolded: "2026-10-10"
dateOpened: "2026-10-10"
tags: []
---

# Lint marker-anchored test fixtures: build them from the exported builder, not a string literal

Prevention owed by PR #4631 review round 4 (F1). A regex anchored on text another module writes (`MECHANICAL_PARK_RE`, `TEST_GAMING_PARK_REASON_RE` in we:scripts/lib/accept-carry-forward.mjs, anchored on we:scripts/merge-ai-prs.mjs#buildDrainReasonComment) is only tied to that writer if its test fixtures are produced by the writer's exported builder. A hand-typed look-alike keeps passing after the writer is reworded, and the consumer silently never matches. Add a test convention or a standards check: a fixture for a marker-anchored regex must come from the exported builder or constant, not a string literal. PR #4631 round 4 converted its own fixtures; this card is the guard against the class.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a test file that feeds a marker-anchored regex a string literal containing the marker, and passes once the literal is replaced by the builder call.

## Non-goals

- [N1] Does not rewrite fixtures outside the files the check flags; each flagged file is converted by its own change.

## Edge cases this change must handle

1. **Untrusted text** — n/a: the check reads repo test sources only.
2. **Truncated reads** — n/a: whole-file source scan.
3. **Shared state files** — n/a: no state is written.
4. **Fail closed** — an unparseable test file is reported, never skipped silently.
5. **Identity scoping** — n/a: repo-wide.
6. **State over time** — a marker added later is picked up from the registry of anchored regexes, not from a hand-kept list in the check.
7. **Who wrote it** — n/a: applies to agent and human authors alike.
