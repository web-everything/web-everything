---
bornAs: xs4q8v2
kind: story
size: 3
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/worker.test.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:package.json", "we:pnpm-lock.yaml"]
dateOpened: "2026-11-15"
tags: []
---

# Test the PR event SQL and memory adapters against one storage contract

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29: correctness/test-coverage and security/coverage both flag untested production SQL. The memory adapter alone cannot catch migration, OFFSET, keep-condition or highest-pruned-seq SQL defects.

Latest advisory linkage: PR #6889, 2026-11-16T05:37:58Z, head ae079849826a461c809a93df310d133f759eb31c. A5 carries the correctness/correctness prevention obligation jointly with #8365: enforce the serialized-row limit at default capacity in the shared adapter suite. A6 carries the codex-correctness bootstrap-freshness watermark card suggestion. Production SQLite tests now exist in we:scripts/conveyor/pr-events-worker/__tests__/sql-adapter.test.mjs; the opening paragraph records the historical finding, while this card adds shared-contract and freshness coverage.

## Acceptance

- [A1] **Executable** — add we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs with the same createEventLog insert, duplicate, transaction rollback, prune and gap scenarios for createMemoryStorage and sqlStorage. Back sql.exec with actual SQLite (node:sqlite when supported, otherwise a declared SQLite test dependency), rather than a SQL-string-matching mock.
- [A2] Exercise fresh schema and an existing events table without keep, including populated rows, repeated initialization and migration failure. Existing facts survive migration; failure is surfaced rather than mistaken for an already-applied migration.
- [A3] Pin zero, one and over-limit runtime counts, cutoff equality and age expiry, facts interleaved with runtime rows, and the highest deleted seq when holes remain. Assert retained contents, monotonic seq, more and gap through createEventLog reads.
- [A4] Show the suite reddens when the SQL keep predicate, OFFSET boundary or highest-pruned-seq query is broken. Each adapter must be explicitly registered in the shared suite so future adapters cannot silently omit it.
- [A5] Integrate #8365's storage double rejecting serialized rows above 2 MB into this shared suite for both adapters, with a negative control proving the limit is enforced. Keep its byte-bound tests named in #8365 rather than substituting an unrestricted memory-only run.
- [A6] Pin repoFreshness bootstrap coverage when baseCursor is behind, equal to and ahead of highestPrunedSeq. Include a retained runtime row hiding a pruned fact, and runtime-only pruning that conservatively reports a gap. Document the current conservative behavior rather than silently changing freshness policy.

## Test plan

Planned names in we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs:

- A1 — **Preservation (GREEN today)**: 'memory and SQLite share insert duplicate rollback prune and gap behavior'. Planned mutation proof: bypass rollback or duplicate detection.
- A2 — **Preservation (GREEN today)**: 'SQLite keep migration preserves populated facts and surfaces initialization failure'. Planned mutation proof: skip the keep migration or swallow an initialization error.
- A3, A4 — **Preservation (GREEN today)**: 'per-class pruning preserves cutoff equality and highest deleted seq'. Planned mutation proof: break the keep predicate, OFFSET boundary or highest-pruned-seq query independently.
- A5 — **Capability (Red today)**: 'runtime keys stay below the serialized row limit' and its passing negative control 'storage double rejects oversized serialized rows', as specified by #8365.
- A6 — **Preservation (GREEN today)**: 'bootstrap freshness detects pruned sequence holes' and 'runtime-only pruning conservatively invalidates bootstrap coverage'. Assert the observable freshness result through createEventLog, not only storage metadata. Planned mutation proof: remove the highestPrunedSeq coverage clause.

## Proof plan

Record each adapter's named results against actual SQLite and memory. Demonstrate red for the keep predicate, OFFSET boundary and watermark behavior using the approved red-proof workflow. Include the size-limit negative control and freshness boundary results. Existing SQLite Worker tests are prior evidence; this card adds the shared contract and does not claim those tests are absent.

## Non-goals

- [N1] No Worker deployment, new bindings or retention-policy changes. No general adapter-registration lint in this slice.

## Edge cases this change must handle

1. **Untrusted text** — insert quoted values through bound SQL parameters.
2. **Truncated reads** — assert pagination across deleted-seq holes.
3. **Shared state files** — assert transaction rollback in both adapters.
4. **Fail closed** — initialization/migration failure must be visible.
5. **Identity scoping** — duplicates and separate repo identities behave identically in both adapters.
6. **State over time** — test migration, count/age pruning and reader cursors behind pruned rows.
7. **Who wrote it** — n/a: storage contract does not change endpoint authentication.
