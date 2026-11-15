---
kind: story
size: 3
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Bound runtime idempotency storage by SQL row size and repo length

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29: correctness/correctness and security/resource-bound both identify the single runtimeKeys projection document as a storage risk. Count bounds alone do not bound serialized bytes; repo currently has no length cap.

The review reports a 2 MB Durable Object SQLite row limit. A growing map can exceed it before the advertised 20,000-key cap, rolling back runtime appends. A token holder can also supply a long repo. Preserve deduplication after event-row pruning while removing the whole-document rewrite.

## Acceptance

- [A1] **Executable** — add a size-limited storage double in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs that rejects any serialized row above 2 MB. Append more than 15,000 distinct realistic runtime keys and then the full default 20,000-key capacity; all writes succeed and each row remains below 1 MB. Demonstrate red against the current single-document implementation.
- [A2] Store one row per idempotency key in we:scripts/conveyor/pr-events-worker/worker.mjs and mirror the contract in memory storage. Evict oldest keys by count and age with DELETE; retain atomic append/key writes and replay protection after runtime-row pruning. Cover migration of the existing runtimeKeys/all projection without discarding live keys.
- [A3] Cap repo at 140 characters in validateRuntimeEvent before any storage mutation. Test the boundary and an oversized valid-looking owner/name through POST /runtime-events; oversized input returns 400 and stores nothing. Include maximum-length repo, action and cause in byte-bound coverage.
- [A4] Test expiry, count eviction, equal timestamps, duplicate writes, failed transaction rollback and subsequent endpoint recovery. A rejected input must not poison later valid writes. Document the existing age/count replay fallback and any migration failure escalation.

## Non-goals

- [N1] Per-role secret bindings remain #8354. No deployment, authentication changes or endpoint rate/body-limit changes.
- [N2] A generic lint requiring maximum lengths on all strict-validator string fields is a longer-term extension; this card guards the runtime key path directly.

## Edge cases this change must handle

1. **Untrusted text** — bound repo before key serialization; include escaped key text in byte measurements.
2. **Truncated reads** — migrate every live legacy key; incomplete migration fails closed.
3. **Shared state files** — key insertion, event insertion and eviction share one storage transaction.
4. **Fail closed** — oversize repo writes nothing; storage failure rolls back atomically.
5. **Identity scoping** — preserve repo/PR/head/action/cause/type identity and existing case normalization.
6. **State over time** — exercise old projection migration, key expiry and replay after row expiry.
7. **Who wrote it** — preserve the existing authenticated-writer boundary; claimed roles remain unchanged.
