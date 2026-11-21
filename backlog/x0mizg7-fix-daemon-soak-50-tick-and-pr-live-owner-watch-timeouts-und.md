---
kind: task
status: open
scope: ["we:scripts/ci/test-timings.json", "we:scripts/conveyor/__tests__/pr-live-owner-watch.test.mjs", "we:scripts/conveyor/soak/daemon-soak.soak.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Fix daemon-soak 50-tick and pr-live-owner-watch timeouts under saturated shards

Owner of 2 main-red quarantines (expire 2026-11-21 22:43 ET): daemon-soak 50-tick timeout and the pr-live-owner-watch expectedHead 5000ms timeout under saturated shards after #7259. Consider re-balancing timings; unquarantine before ttl. Source: build-queue 22:43 ET.

## Acceptance

- [A1] **Executable** — Planned `completes 50 daemon ticks under saturated shards` in `we:scripts/conveyor/soak/daemon-soak.soak.test.mjs`: Run the real daemon fixture with saturated shard capacity; assert exactly 50 completed ticks before the measured soak deadline and no timeout quarantine remains.
- [A2] **Executable** — Planned `expectedHead watch completes under saturated shards` in `we:scripts/conveyor/__tests__/pr-live-owner-watch.test.mjs`: Drive the real expectedHead watch under the same load; assert it observes the requested head within its measured bound and its timeout quarantine is removed before expiry.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No blanket timeout increase or worker-count increase.

## Edge cases this change must handle

1. **Untrusted text** — Treat watch output as data.
2. **Truncated reads** — Incomplete tick or head evidence cannot count as completion.
3. **Shared state files** — Keep timing changes limited to the two quarantined cases.
4. **Fail closed** — A timed-out watch remains a failure.
5. **Identity scoping** — Match expectedHead to the watched PR.
6. **State over time** — Exercise saturated shards and quarantine expiry.
7. **Who wrote it** — Only observed timing evidence justifies unquarantining.

## Duplicate admission

new card from build-queue CARD line
