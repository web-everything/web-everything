---
kind: story
size: 3
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:package.json", "we:pnpm-lock.yaml"]
dateOpened: "2026-11-15"
tags: []
---

# Test the PR event SQL and memory adapters against one storage contract

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29: correctness/test-coverage and security/coverage both flag untested production SQL. The memory adapter alone cannot catch migration, OFFSET, keep-condition or highest-pruned-seq SQL defects.

## Acceptance

- [A1] **Executable** — add we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs with the same createEventLog insert, duplicate, transaction rollback, prune and gap scenarios for createMemoryStorage and sqlStorage. Back sql.exec with actual SQLite (node:sqlite when supported, otherwise a declared SQLite test dependency), rather than a SQL-string-matching mock.
- [A2] Exercise fresh schema and an existing events table without keep, including populated rows, repeated initialization and migration failure. Existing facts survive migration; failure is surfaced rather than mistaken for an already-applied migration.
- [A3] Pin zero, one and over-limit runtime counts, cutoff equality and age expiry, facts interleaved with runtime rows, and the highest deleted seq when holes remain. Assert retained contents, monotonic seq, more and gap through createEventLog reads.
- [A4] Show the suite reddens when the SQL keep predicate, OFFSET boundary or highest-pruned-seq query is broken. Each adapter must be explicitly registered in the shared suite so future adapters cannot silently omit it.

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
