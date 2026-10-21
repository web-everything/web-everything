---
bornAs: xdpemd4
kind: story
size: 2
parent: "3999"
status: open
dateOpened: "2026-09-23"
tags: []
scope: ["we:skills-src/conveyor/pass-daemon.mjs", "we:skills-src/conveyor/__tests__/pass-daemon.test.mjs", "we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs"]
---

# Self-sync for we:skills-src/conveyor/pass-daemon.mjs watchers

The requested opt-in self-sync wiring is already present in pass-daemon, including restart/lease release and per-tick version roots. Treat this card as verification of that implementation: close the gap between testing a copied wiring pattern and testing the production composition, repairing only discrepancies the probe demonstrates. Preserve the existing opt-in default. Size 2 covers an injectable production-composition seam and focused integration coverage, not a second self-sync implementation.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:skills-src/conveyor/__tests__/pass-daemon.test.mjs` — add a regression that drives the production composition with fake sync, lease, exit and spawn effects. It must fail when the production withSelfSync hookup is removed even though the existing copied-pattern test still passes. This is the remaining red/green proof; existing tests alone are not a pre-change failure claim.
- [A2] With opt-in unset, no sync call occurs and each pass runs once. With PASS_DAEMON_SELF_SYNC=1, adoption of changed imported code releases only the owned lease, stops the heartbeat and requests restart without spawning the old pass. An up-to-date tick runs once.
- [A3] Cover main-only rejection of POC tracking, sync failure without false adoption, and a versioned tick spawning from its pinned tickRoot. In a temporary clone/process smoke probe, record old/new child code identity and prove no concurrent old-code tick after adoption.

## Non-goals

- [N1] No default-on rollout, launchd fleet change, or new POC/overlay policy; broader default behavior remains separate work.
- [N2] No automatic status change based solely on finding existing code.

## Edge cases this change must handle

1. **Untrusted text** — Pass names resolve from the manifest; branch and root values remain validated inputs, never shell fragments.
2. **Truncated reads** — Propagate incomplete git/status/rebuild reads through the existing helper refusal behavior; never interpret partial output as adopted code.
3. **Shared state files** — Reuse rebuild locking and releaseRunnerLeaseIfOwned; a restart must not release another process’s lease.
4. **Fail closed** — A failed sync cannot report adoption or spawn from an unverified candidate; retain existing helper handling rather than inventing a permissive fallback.
5. **Identity scoping** — Bind lease release to pass/repo/owner and child launch to the pinned version root; preserve main-only pass identity.
6. **State over time** — Test adoption between ticks, an unchanged tick, restart re-entry and signals racing restart; request exit/release at most once.
7. **Who wrote it** — Only the existing sync/adoption helper determines runnable code; manifest text or pass output cannot assert trusted adoption.

## Grounding

- we:skills-src/conveyor/pass-daemon.mjs:95 already resolves opt-in; :345 releases the lease and exits on restart; :376 wraps the real spawn with withSelfSync.
- we:skills-src/conveyor/pass-daemon.mjs:373 threads the pinned tickRoot into child launch.
- we:skills-src/conveyor/__tests__/pass-daemon.test.mjs:179 explicitly tests the wiring pattern rather than main itself; :191 covers restart instead of run.
- Commit 45540687ed introduced the graduated pass-daemon self-sync; the requested runtime wiring looks shipped, while production-composition verification remains.
