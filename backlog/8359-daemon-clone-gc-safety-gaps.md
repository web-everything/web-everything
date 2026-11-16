---
bornAs: x87unon
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
related: ["probation-rollback-noreclaim-failclosed"]
---

# Daemon clone GC safety gaps and the bad tree object clone integrity error

The daemon clone GC fix (overlay `lane/daemon-clone-gc`, live on the fix daemon) was audited WEAKENED with real safety gaps in `we:scripts/lib/daemon-rebuild/clone-maintenance.mjs`: it bypasses the two-week prune floor (an inherited `gc.pruneExpire=now` can delete at once), omits the `cloneGitIsBusy` guard, uses `execFile` without process-group cleanup so repack/prune children outlive the lock, accepts symlinked or separate git dirs as "owned", reuses fail-open lease liveness (malformed or expired leases of live processes permit GC) and the rebuild-job scan is missing, and keeps a separate best-effort stamp. This morning's "bad tree object" clone integrity error on a daemon clone may come from exactly this path. Close the gaps and check the incident against them.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/soak/breaks/daemon-clone-gc-skips-busy-clone.soak.test.mjs` also covers the prune floor, busy guard, process-group kill, shared-store refusal, fail-closed leases and the shared stamp, using the daemon-rebuild module the hook really calls.

## Non-goals

- [N1] n/a: the rollback lock findings live in the probation card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no external text enters the GC path.
2. **Truncated reads** — an unreadable lease, stamp or rebuild job refuses GC.
3. **Shared state files** — one maintenance stamp shared with the existing path; a corrupt stamp refuses.
4. **Fail closed** — unknown liveness or busy evidence refuses GC.
5. **Identity scoping** — only a clone owned by this daemon, not a symlinked or shared store.
6. **State over time** — prune floor and interval apply across restarts.
7. **Who wrote it** — n/a: GC runs only from the daemon.

## Duplicate admission

Same incident family as the probation rollback residuals: unsafe or fail-open daemon clone operations.

The GC-safety findings come from the clone-gc audit; the probation card covers rollback locking.
