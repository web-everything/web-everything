---
bornAs: xoi0zbm
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# heavy-admission should route an overloaded run to Forge instead of deferring it when remote mode is always

Live 2026-10-31 10:40 ET (lane-2): heavy-admission DEFERRED 'npm run check:standards' for host load (84 on 12 cores > 6/core) while heavyAdmission.remote.mode=always and Forge was idle (~1). Overload should route remote, not defer. Check the order of the load-cap test vs the remote decision, and whether check:standards is on the remote allowlist. Prove on a lane run under load.

## Acceptance

- [A1] **Executable** — the 7579 cases in `we:scripts/readiness/__tests__/heavy-admission-remote.test.mjs` (run that file with `npx vitest run <file> -t 7579`): with the host overloaded and every Forge slot taken, `runWithRemoteDecision` keeps waiting for a Forge slot and runs remotely (fails before: falls back to local after 30 s and defers).
- [A2] Must refuse on error: a throwing or "unknown" host-load/memory reading is NOT an overload; an unreadable/unhealthy Forge, backoff, a refused remote result, or a run timeout falls back to local admission exactly as before (local then defers on overload).
- [A3] Must respect `remote.maxConcurrent` and the remote slot locks (`slot-N.unconfirmed` markers stay excluded); nothing becomes remote-eligible that was not before, except `above-threshold` mode with remote enabled and a readable load, where a definite host overload now counts as a remote trigger.
- [A4] Live proof (2026-11-01 ET, lane-60, private pool with all 8 Forge slots filled, overload simulated with `WE_HOST_MAX_LOAD_PER_CORE=0.01`): before 01:42 ET `remote-full (30s wait exhausted)` → `heavy-command admission deferred` exit 75; after 01:43 ET `waiting for a remote slot instead of deferring locally` → slots freed → `RUN /srv/forge-exec/slot-8/...` 17/17, exit 0.

Finding: the 10:40 ET incident's own path was different: Forge ran check:standards, and the client returned `cancelled` `incomplete-standards-inputs` (its output classifier matches "no changed tier lines; nothing to attribute"), so the run fell back locally and deferred. That is a remote refusal and stays fail-closed here; the classifier lives in `we:scripts/readiness/remote-exec.mjs` (out of scope).

## Non-goals

- [N1] Does not change `we:scripts/readiness/remote-exec.mjs` or its check:standards completeness classifier, the remote allowlist, `we:scripts/readiness/forge-remote-health.mjs`, or local admission itself.

## Edge cases this change must handle

1. **Untrusted text** — n/a: only reads the local load verdict object; the reason string is matched against a fixed prefix and never executed.
2. **Truncated reads** — n/a: no new file reads; slot-marker scans and health reads are the existing ones.
3. **Shared state files** — the remote slot locks and `.unconfirmed` markers are used exactly as before (same `tryAcquireSlot`, same cap); the longer wait only polls them.
4. **Fail closed** — unreadable host load/memory, a throwing check, unhealthy Forge (rechecked every 10 s while waiting) or reaching the run timeout all take today's local fallback.
5. **Identity scoping** — n/a: the slot owner identity is unchanged (per-process `remote-<pid>-<random>`).
6. **State over time** — overload is re-read on every wait step after 30 s; if the host recovers, the run falls back to local admission as before.
7. **Who wrote it** — n/a: no new authored input; settings come from the existing cascade.
