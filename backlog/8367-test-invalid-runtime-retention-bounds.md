---
bornAs: xt9n3c6
kind: story
size: 1
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Pin the fail-closed runtime retention bounds

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29, security/coverage at createEventLog: the invalid runtime retention bounds guard has no named test. NaN can disable pruning if this guard regresses.

Latest advisory linkage: PR #6889, 2026-11-16T05:37:58Z, head ae079849826a461c809a93df310d133f759eb31c. A1–A3 carry security/coverage's invalid-bound test request and the codex-correctness invalid-option card suggestion. The general named-test checklist obligation for fail-closed guards is carried by #8369 A4; this card supplies the concrete throwing-path test plan.

## Acceptance

- [A1] **Executable** — add 'rejects invalid runtime retention bounds' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs. Independently pass NaN, Infinity and negative values for each runtime age/count option, fractional counts and maxRuntimeKeys 0. Expect 'invalid runtime retention bounds' before any storage writes.
- [A2] Pin the valid edge maxRuntimeEvents 0: appends retain no runtime rows while bounded key history still deduplicates. Cover valid minimum key count and zero age windows according to the existing guard contract.
- [A3] Demonstrate the negative cases redden if the corresponding guard clauses are removed; keep invalid configuration fail-closed rather than silently substituting defaults.

## Test plan

Planned names in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs:

- A1, A3 — **Preservation (GREEN today)**: 'rejects invalid runtime retention bounds', parameterized independently across all four options and invalid shapes listed in A1, with a storage-write spy. Planned mutation proof: drop each independent guard clause.
- A2 — **Preservation (GREEN today)**: 'zero runtime row retention preserves bounded deduplication' and 'minimum key count and zero age windows remain valid'. Pin cutoff equality and the first later timestamp without wall-clock waits. Planned mutation proof: retain a runtime row at cap zero or reject a valid zero age window.

## Proof plan

Record named red/green results for invalid bounds and valid edges. Use the approved red-proof workflow for an already-fixed guard; never remove a guard manually to manufacture red. Each independent guard clause needs a failing case, and zero-row retention must still deduplicate after the event row disappears.

## Non-goals

- [N1] No retention default changes or production guard changes unless a test exposes a mismatch with the existing documented contract.

## Edge cases this change must handle

1. **Untrusted text** — n/a: numeric constructor configuration only.
2. **Truncated reads** — n/a: constructor validation does not read pages.
3. **Shared state files** — assert invalid construction performs no writes.
4. **Fail closed** — invalid numbers throw; NaN never disables pruning.
5. **Identity scoping** — n/a: configuration applies to the whole log.
6. **State over time** — test zero retained rows with surviving deduplication evidence.
7. **Who wrote it** — n/a: no authentication change.
