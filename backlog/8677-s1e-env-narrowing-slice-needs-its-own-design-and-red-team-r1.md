---
bornAs: xuml6hx
kind: task
status: open
scope: ["we:designs/pr7170-rescope-judgement.md", "we:scripts/__tests__/s1e-design-contract.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# S1e env-narrowing slice needs its own design and red team (R115)

From the #7170 rescope: the S1e environment-narrowing slice needs its own design and a red team (R115) before build. Source: we:designs/pr7170-rescope-judgement.md; build-queue 22:24 ET 2026-11-20.

## Acceptance

- [A1] **Executable · Planned** — Run `test_file=we:scripts/__tests__/s1e-design-contract.test.mjs; npm run test:unit -- "${test_file#we:}"`; add a design-contract test requiring a separately identified S1e design, explicit inherited/retained/removed environment inputs, refusal and operator-escalation behavior, migration cases, and an R115 red-team record tied to that design revision. Negative fixtures for missing/truncated design, missing review and stale review must block build readiness; a complete fixture passes. Human review judges the design and resolves blocking findings before build.

## Non-goals

- [N1] No runtime environment changes, build authorization from a structural test alone, or repair of the separate pre-existing guard gaps.

## Edge cases this change must handle

1. **Untrusted text** — Fence environment values and red-team findings as data; the design must prohibit evaluating their contents as commands.
2. **Truncated reads** — Missing or partial source design/review evidence blocks readiness and identifies what the operator must recover.
3. **Shared state files** — Document which shared environment/state inputs S1e reads and owns; this design-only item does not mutate runtime state.
4. **Fail closed** — Absent design, unresolved blocking findings or unverifiable review provenance keeps the slice unready for build.
5. **Identity scoping** — Specify which process/repository receives the narrowed environment and how sibling identities remain isolated.
6. **State over time** — Require review against the current design revision and document treatment of resumed runs with older inherited environments.
7. **Who wrote it** — Record design and red-team authorship with revision provenance; copied approval text cannot establish R115 completion.

## Duplicate admission

nd
