---
kind: story
size: 3
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/lib/", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Prevention — require coverage for automated candidate exclusions and card-group wiring

PR #5762's advisory review (2026-10-20) owes prevention for the security and correctness coverage findings. A positive membership test did not protect the default-repository conflict-watch call path. Candidate exclusions, bounded queue readers, resolver refusal classes and drain orchestration also need named negative cases carried with their implementation. This card tracks mechanical enforcement beyond the regression cases added by that repair.

## Acceptance

- [A1] **Executable** — `npm run check:standards` rejects a fixture that introduces an unclassified skip/defer kind in a landing path. Enumerate emitted scheduling/admission kinds, including helper-returned kinds, and compare them with an explicit inventory; do not confuse unrelated error/status `kind` fields with drain kinds.
- [A2] **Executable** — `npm run check:standards` rejects a fixture adding a `scripts/lib/*.mjs` export with no sibling test reference. Carry test files with carried library files. Cover both a missing test and an existing but unrelated test.
- [A3] **Executable** — A standards-rule fixture containing an untested automated candidate exclusion fails; a table-driven exclusion with named negative cases passes. Apply this to item, couple, coupleKey and sibling-repository exclusions in card grouping, and to every `cardGrouping.*` call site in the drain. The rule may require an explicit test map rather than infer semantic coverage from test text.
- [A4] **Executable** — The suites we:scripts/lib/__tests__/card-group-drain-wiring.test.mjs, we:scripts/lib/__tests__/card-group.test.mjs, we:scripts/lib/__tests__/queue-file-overlap.test.mjs, we:scripts/lib/__tests__/card-conflict-resolve.test.mjs and we:scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs exercise source and combined membership, cascade holds, collision repair, ordinary rebase, manifest stripping, whole-pass formation/reconciliation, candidate exclusions, queue truncation, conflict dissolution and resolver refusals. Preserve these cases in the normal affected-test gate.
- [A5] **Must** — Missing or empty repository identity in an exemption reader must produce a diagnostic or explicit refusal, with a named empty-slug test. It must never exempt a foreign PR with the same number. Preserve the no-group/empty-sweep fast path and test repository-resolution failures before any mutation.
- [A6] **Executable** — Each `inGroup`/`holdFor` landing exemption names its freshness owner and a test covering both merge strategies. Add standards fixtures named `rejects a group exemption without a freshness owner`, `rejects an exemption with only queue coverage`, and `accepts an exemption with both strategy cases`. Extend the rebase, collision-repair and conflict-watch wiring matrix across queue/direct, source/combined and BEHIND/DIRTY. Queue-owned BEHIND may stay grouped; otherwise require a repair or dissolution, with source holds and file reservations released only after successful combined-PR closure.

## Non-goals

- [N1] Change review clearance, expand conflict auto-resolution, or bypass the merge queue. Existing “not-real” rulings on closure proof and mutex findings are not reopened by this card.

## Edge cases this change must handle

1. **Untrusted text** — Scan parsed source declarations, never execute source strings or reason text.
2. **Truncated reads** — Truncated queue pages and capped file lists keep grouping blocked; unreadable source scans fail the standards rule explicitly.
3. **Shared state files** — Test writers use isolated temporary state; enforcement performs no production state writes.
4. **Fail closed** — Unknown kinds, absent test mappings and unknown identity cannot silently pass.
5. **Identity scoping** — Exercise explicit/default repos, foreign numeric collisions, source and combined roles, and recorded combined branch identity.
6. **State over time** — Cover dissolved groups, unreadable state, conflict recovery, and settings that disable grouping or auto-resolution.
7. **Who wrote it** — A test reference is coverage evidence, never review acceptance or authorization to land.

## Risks

Text-only matching can reward a test that names an export without exercising it. Use deterministic rule fixtures, and keep behavioral assertions for actual repair/enqueue calls. Excessively broad source scanning can classify non-drain status kinds incorrectly; bound the emitter set and report unsupported syntax.

## Test plan

Add accepted and rejected fixtures for A1–A3 to the standards rule tests; include helper-returned kinds and unrelated kinds. Run the A4 suites through heavy admission, plus the existing conflict-watch soak break `card-group-default-repo-conflict-watch`. Verify that removing each exemption or truncation guard makes its own regression case fail. Do not weaken production guards manually to obtain red evidence; use the verify harness's revert-red proof.

For A6, preserve `stale group freshness has an owner (queue=$queue, role=$role, state=$mergeState)` and `a failed close after switching to direct keeps holds until the next successful reconcile` in `scripts/lib/__tests__/card-group-drain-wiring.test.mjs`. These exercise a persisted queue group after main advances and the delivery strategy changes (PR #5762, send-back IC_kwDORBt1-c8AAAABe8aSDg). Add `collision repair exemptions retain a freshness owner across strategies` and `conflict-watch exemptions retain a freshness owner across strategies` for the remaining exemption sites, asserting repair or dissolution and eventual source release. The A6 standards fixtures must reject a named test map missing either strategy even when its test file exists.

From the WE checkout, run the A4 suites:

```bash
npm run test:unit -- scripts/lib/__tests__/card-group-drain-wiring.test.mjs scripts/lib/__tests__/card-group.test.mjs scripts/lib/__tests__/queue-file-overlap.test.mjs scripts/lib/__tests__/card-conflict-resolve.test.mjs scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs
```
