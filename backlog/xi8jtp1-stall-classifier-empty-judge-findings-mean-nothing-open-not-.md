---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-stall-classify.mjs"]
dateOpened: "2026-11-17"
tags: []
---

# Stall classifier: empty judge findings mean nothing open, not malformed

we:scripts/conveyor/pr-stall-classify.mjs reports the open findings as missing or malformed when every break was carded and the latest list is empty (case #6957); treat a consistent empty list as nothing open.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs` (runner: we:scripts/readiness/heavy-admission.mjs; regression: we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs). Consistent empty findings route to the existing operator extend-rounds command with a nothing-open reason, including the #6957 replay; no new action kind.
- **Must refuse on error** — Missing/malformed evidence, inconsistent counts, unknown/nonzero cross-source breaks, and guard paths retain operator refusal. Empty findings never authorize an automatic ruling or grant.
- **Must preserve caution for every file kind** — Source, docs, config, and data all require the existing complete canonical file list and guard checks; an empty finding list does not exempt any file kind.

The soak replay lives at we:scripts/conveyor/soak/breaks/stall-classify-empty-findings.mjs with its harness entry at we:scripts/conveyor/soak/breaks/stall-classify-empty-findings.soak.test.mjs.

## Non-goals

- [N1] No new actions, automatic clear/grant, policy changes, guard exemptions, or changes to nonempty finding handling. No receive/write endpoint is added; body-size, rate-limit, CSRF/origin, and reset-trigger controls do not apply to this pure classifier.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Findings/reasons remain plain validated data; the new reason is static and the existing command builder supplies the operator command.
2. **Truncated reads** — Missing evidence or a count/class mismatch still refuses; only a validated empty array with zero tallies means nothing open.
3. **Shared state files** — n/a: the classifier reads its supplied snapshot and writes no state.
4. **Fail closed** — Unknown/nonzero crossBroken, malformed findings, incomplete file evidence, and guard paths retain refusal; regressions cover inconsistent empty counts and cross-source/guard checks.
5. **Identity scoping** — Existing repository, PR, actor, trigger, and exact judged-head validation stays in place; the #6957 replay checks its PR-specific command.
6. **State over time** — A formerly confirmed break may be carded and leave latest empty; the current validated snapshot routes nothing open to the operator, without reusing historical findings as an open fix list.
7. **Who wrote it** — Existing verdict/input validation and upstream provenance remain unchanged; an empty snapshot grants no new automatic authority.
