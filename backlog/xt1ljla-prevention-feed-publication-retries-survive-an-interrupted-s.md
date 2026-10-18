---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — feed publication retries survive an interrupted state write

PR #5537 self-review checked we:scripts/operations/needs-you-feed.mjs publishAttention and found a pre-existing shared-state window: appendLines succeeds before writeJsonAtomic persists openKeys, so a crash or state-write failure can duplicate delivery on retry. The test-gaming route now retries pending notification and uses this shared publisher; improve the shared primitive with a deterministic fault-injection regression for append-success/state-write-failure and restart, without silently losing an event or clearing unrelated attention keys. This shared helper is outside the repair scope of PR #5537.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/needs-you-feed.test.mjs` includes a deterministic regression that fails on append-success/state-write-failure followed by restart, and passes after recovery becomes idempotent.
- [A2] Exercise failed append, failed state persistence, restart after append and concurrent writers; require one durable event per attention transition without dropping unrelated open keys.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Do not change attention classification, human review ownership or merge-gate clearance.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — retain the shared feed's display sanitization and field bounds during recovery.
2. **Truncated reads** — never treat an incomplete final event or corrupt state as confirmed delivery.
3. **Shared state files** — serialize writers and recover from a crash between event append and deduplication-state persistence.
4. **Fail closed** — propagate storage errors; never acknowledge undelivered attention.
5. **Identity scoping** — deduplicate by repo, PR, head and event kind while preserving separate attention transitions.
6. **State over time** — cover restart, retry, acknowledgement and attention clearing before a later recurrence.
7. **Who wrote it** — use the existing producer and path guards; do not relax them for recovery.

## Filing handoff

Created through the declared file-item operation in the restricted repair lane. Queue clearance is deferred to the launcher because this sandbox permits only lane and temporary-file writes.
