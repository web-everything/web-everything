---
kind: story
size: 3
parent: "xf7ax93"
status: open
blockedBy: ["xu8wvf7"]
scope: ["we:scripts/conveyor/decider-daemon.mjs", "we:scripts/lib/pr-facts.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Safety pass: re-decide every open PR from the projection every 5 min, batched GitHub re-sync every 15 min, call budget alert

Ruling E5. Re-decide all open PRs every 5 min from the cached projection (zero GitHub calls), re-sync the projection with GitHub every 15 min and on boot, gap or reset (target one batched GraphQL query for all open PRs), honour decide recheckAt timers, and count missed-by-events per cause. Operator condition: intervals are settings, calls per re-sync are logged, and an alert fires over a budget setting.

## Acceptance

- [A1] **Executable** — a test drops one event from a recorded stream and asserts the 5-min re-decide still requests the owed action and increments "missed by events" for that cause.
- [A2] Re-decide of every open PR from the cached projection makes zero GitHub calls.
- [A3] The GitHub re-sync runs every 15 min and on boot, `gap` or `reset`, as one batched GraphQL query for all open PRs (a handful of calls), with ETag or equivalent caching where the API allows.
- [A4] Both intervals are settings. Calls per re-sync are logged; an alert fires when they exceed a budget setting.
- [A5] A "missed by events" counter per cause is reported; the intervals may only grow while it stays at 0.

## Non-goals

- [N1] No full GitHub sweep per PR; only the batched re-sync touches GitHub.
- [N2] Choosing the larger intervals is a later settings change, not this slice.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — re-synced PR fields are data, read by typed field only.
2. **Truncated reads** — a paged or cut-off GraphQL answer is treated as incomplete: the projection is not replaced, and the next attempt runs.
3. **Shared state files** — the decider is the one writer of the projection cache.
4. **Fail closed** — a failed re-sync keeps the old projection, raises the stale flag, and the decider requests nothing on stale PRs.
5. **Identity scoping** — the re-sync is per repo.
6. **State over time** — the projection records when it was last re-synced; staleness is checked on every decide.
7. **Who wrote it** — n/a: the projection is derived; source events keep their writer.
