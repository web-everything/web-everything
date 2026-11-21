---
kind: task
status: open
scope: ["we:scripts/capability-search.mjs", "we:scripts/__tests__/capability-search.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Reinforce the #7269 trial: narrow plateau terms, strict placement parsing, restrict --out

#7269 trial reinforce-later items: narrow the plateau terms (review and gate pushes pushed plateau-app routing to 68%), parse explicit placement strictly, restrict --out. The PII-flow card was misrouted to plateau-app. Source: build-queue 22:15 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `routes PII flow without broad plateau term capture` in `we:scripts/__tests__/capability-search.test.mjs`: Replay the misrouted PII-flow example and unrelated plateau terms; assert routing uses the narrowed terms and the PII example reaches its intended destination.
- [A2] **Executable** — Planned `strictly parses explicit placement` in `we:scripts/__tests__/capability-search.test.mjs`: Parameterize valid placement, malformed syntax and trailing input; assert only valid complete placement is accepted.
- [A3] **Executable** — Planned `rejects disallowed output destinations` in `we:scripts/__tests__/capability-search.test.mjs`: Pass each disallowed --out value; assert explicit refusal and no output artifact.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No unrelated routing vocabulary expansion.

## Edge cases this change must handle

1. **Untrusted text** — Placement and output arguments are data.
2. **Truncated reads** — Partial placement input is rejected.
3. **Shared state files** — Do not overwrite output outside the allowed destination.
4. **Fail closed** — Ambiguous placement or invalid output paths refuse with a reason.
5. **Identity scoping** — Keep plateau-app placement distinct from other targets.
6. **State over time** — Repeat routing with the same inputs to pin stability.
7. **Who wrote it** — Caller text cannot override output restrictions.

## Duplicate admission

new card from build-queue CARD line
