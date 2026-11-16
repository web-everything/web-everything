---
bornAs: xr6k2m9
kind: story
size: 3
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/worker.test.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Bound runtime idempotency storage by SQL row size and repo length

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29: correctness/correctness and security/resource-bound both identify the single runtimeKeys projection document as a storage risk. Count bounds alone do not bound serialized bytes; repo currently has no length cap.

The review reports a 2 MB Durable Object SQLite row limit. A growing map can exceed it before the advertised 20,000-key cap, rolling back runtime appends. A token holder can also supply a long repo. Preserve deduplication after event-row pruning while removing the whole-document rewrite.

Latest advisory linkage: PR #6889, 2026-11-16T05:37:58Z, head ae079849826a461c809a93df310d133f759eb31c. This existing open card carries the correctness/correctness prevention obligation: A1 and A5 require the 2 MB storage double at the default 20,000-key capacity in #8366's shared adapter suite. It also carries security/resource-bound (A6's maximum-length rule) and the codex-correctness row-size card suggestion. These are planned follow-ups, not an implemented storage repair or a review verdict.

## Acceptance

- [A1] **Executable** — add a size-limited storage double in we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs that rejects any serialized row above 2 MB. Append more than 15,000 distinct realistic runtime keys and then the full default 20,000-key capacity; all writes succeed and each row remains below 1 MB. Demonstrate red against the current single-document implementation.
- [A2] Store one row per idempotency key in we:scripts/conveyor/pr-events-worker/worker.mjs and mirror the contract in memory storage. Evict oldest keys by count and age with DELETE; retain atomic append/key writes and replay protection after runtime-row pruning. Cover migration of the existing runtimeKeys/all projection without discarding live keys.
- [A3] Cap repo at 140 characters in validateRuntimeEvent before any storage mutation. Test the boundary and an oversized valid-looking owner/name through POST /runtime-events; oversized input returns 400 and stores nothing. Include maximum-length repo, action and cause in byte-bound coverage.
- [A4] Test expiry, count eviction, equal timestamps, duplicate writes, failed transaction rollback and subsequent endpoint recovery. A rejected input must not poison later valid writes. Document the existing age/count replay fallback and any migration failure escalation.
- [A5] Run the serialized-row-size storage double in the shared memory/SQLite adapter contract suite tracked by #8366, including a control that proves the double rejects an oversized row. The double measures UTF-8 bytes of the complete serialized row, including JSON escaping, rather than JavaScript string length.
- [A6] Establish a maximum-length rule for every string field in strict validators in we:scripts/conveyor/pr-events-worker/core.mjs, including validateRuntimeEvent and validateBootstrap. Inventory each field and its explicit limit (fixed-width/enumerated strings count as bounded); test the limit and limit plus one through the authenticated endpoint, asserting rejection stores nothing. Free text stays uninterpreted. A repo-only cap does not satisfy this rule.
- [A7] Check key age before returning a duplicate: replay alone after the 60-day window must observe the documented expiry fallback without an unrelated successful append first. Test just before, at and after expiry with event rows already pruned, and retain live-key deduplication.

## Test plan

All names below are planned tests, not implemented evidence.

- A1, A5 — **Capability (Red today)**: 'runtime keys stay below the serialized row limit' and its negative control 'storage double rejects oversized serialized rows' in we:scripts/conveyor/pr-events-worker/__tests__/storage-contract.test.mjs, registered for both adapters. Include maximum-length fields, escaped text and multibyte UTF-8; check every written row, not just the final snapshot. The capacity assertion is red on the current single-document design; the negative control must pass.
- A2 — **Capability (Red today)**: 'legacy runtime keys migrate atomically without losing live deduplication' in the same shared suite; inject a migration failure and assert the old state survives for retry. The per-key migration does not exist on the base.
- A3, A6 — **Capability (Red today)**: 'strict validators bound every string field before storage' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs, with an explicit field/limit table and endpoint cases.
- A4 — **Preservation (GREEN today)**: 'runtime key eviction and failed writes preserve atomic replay protection' in the shared suite, covering count ties, age equality, rollback and a subsequent valid write. Planned mutation proof: skip key rollback or oldest-key eviction and require the corresponding assertion to fail.
- A7 — **Preservation (GREEN today)**: planned 'expired runtime key replay succeeds without an intervening append' in the shared suite. Replay-only expiry is already covered in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs ('A4: replay-only traffic expires keys after reopening (maxRuntimeEvents=%s)') and we:scripts/conveyor/pr-events-worker/__tests__/sql-adapter.test.mjs ('replay alone expires the default key and row windows through the production appendRuntime method'). This follow-up extends that coverage across the shared adapter contract; coordinate the default-window assertions with #8369.

## Proof plan

Show the byte-limit regression red on the single-document implementation and green on both adapters after repair. Separately show the size double rejects an oversized row and the validator rejects an over-limit string. Preserve the existing replay-only expiry behavior in the shared suite; use the approved historical red-proof workflow if additional discrimination evidence is needed for that already-fixed behavior. Record named test results and any migration escalation; do not treat this filing as an implemented storage fix.

## Non-goals

- [N1] Per-role secret bindings remain #8354. No deployment, authentication changes or endpoint rate/body-limit changes.
- [N2] A repository-wide validator lint is outside this slice; A6 requires the maximum-length rule across every string field of both strict validators in this event-log module.

## Edge cases this change must handle

1. **Untrusted text** — bound repo before key serialization; include escaped key text in byte measurements.
2. **Truncated reads** — migrate every live legacy key; incomplete migration fails closed.
3. **Shared state files** — key insertion, event insertion and eviction share one storage transaction.
4. **Fail closed** — oversize repo writes nothing; storage failure rolls back atomically.
5. **Identity scoping** — preserve repo/PR/head/action/cause/type identity and existing case normalization.
6. **State over time** — exercise old projection migration, key expiry and replay after row expiry.
7. **Who wrote it** — preserve the existing authenticated-writer boundary; claimed roles remain unchanged.
