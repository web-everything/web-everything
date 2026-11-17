---
bornAs: xrjjagi
kind: story
size: 3
status: open
dateOpened: "2026-11-17"
tags: []
---

# Rebuild herd: dry-run holds a smoke slot, rebuild-job interval jitter, step timing lines

On 11-17 00:21Z seven daemons rebuilt at once (600-2176 s vs 27-130 s normal). Hold a smoke slot for the whole dryRunRebuild, jitter rebuildAsJob.minIntervalMs, log timing for the object-DB and overlay-merge steps.

## Acceptance

- [A1] **Executable**:

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/daemon-rebuild/__tests__/preview.test.mjs scripts/lib/daemon-rebuild/__tests__/rebuild-job.test.mjs scripts/lib/__tests__/daemon-smoke-slots.test.mjs
```

- [A2] Dry runs hold shared smoke capacity through object setup and merge planning, release on failure, and refuse with `smoke-queue-timeout` when capacity expires (retry on the next attempt). Nested previews retain an existing process slot. Rollback: `WE_DAEMON_DRY_RUN_HOLDS_SMOKE_SLOT=0`.
- [A3] Job spacing uses stable daemon-name jitter: default 20%, clamped to 0–100%, never below the base interval; 0 disables it. Dry runs emit separate elapsed-ms lines for object-db and overlay-merge. Named tests in the two focused files cover each guarantee.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
