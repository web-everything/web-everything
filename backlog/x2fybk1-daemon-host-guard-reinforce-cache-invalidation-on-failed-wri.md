---
kind: story
size: 2
status: open
dateOpened: "2026-11-16"
tags: []
related: ["daemon-host-guard"]
---

# Daemon host guard reinforce: cache invalidation on failed write, preflight clone-discovery completeness

Reinforce the host guard after R825 residuals: (1) a failed cache write after a successful fresh read naming another host leaves old cache naming this host, so a later failed remote read could reactivate it; fix by tombstone or fail closed on write failure. (2) preflight clone discovery relies on daemonCloneRoots which silently skips unreadable dirs and corrupt overlay records; add a strict discovery mode that reports skips.

Residual (1) fixed in PR #6945 (cache invalidation + failed-read throttle); residual (2) strict clone discovery remains open

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/daemon-host-guard.test.mjs we:scripts/operations/__tests__/daemon-preflight.test.mjs` (through host heavy admission). In particular, 'failed cache write after fresh other-host read cannot reactivate this host on a later failed read' and 'failed remote read is throttled for 60s per host' must pass.

- Must remain standby after non-me evidence cannot be persisted and later remote evidence is unreadable, even if cache removal also fails.
- Must reject malformed, foreign, future-skewed or expired cache evidence; preflight discovery failures must be explicit failed checks.

## Non-goals

- [N1] This PR does not implement strict clone discovery or wire the guard into daemons. Strict discovery remains residual (2) on this open card.

## Edge cases this change must handle

1. **Untrusted text** — Validate host names and canonical base64 owner contents; execute commands with argv and strip control characters from preflight output. No receive endpoint: CSRF/origin checks are n/a.
2. **Truncated reads** — Bound child output to 1 MiB and execution to 15 seconds; failed commands, malformed JSON and incomplete cache evidence cannot establish ownership. Inspect the owner branch/cache and retry after repairing unreadable evidence.
3. **Shared state files** — Replace cache atomically using a unique mode-0600 temporary file; remove temporary files on failure. After a failed non-me write, attempt removal and retain in-memory poison even when removal fails.
4. **Fail closed** — Startup requires fresh remote evidence; poisoned fallback is standby `cache-invalidated`. Unknown reads grant no ownership without valid bounded cache evidence. Preflight uses no cache IO and reports unreadable ownership as a failed check.
5. **Identity scoping** — Scope cache evidence, poison and failed-read throttles to the host. Injected guard state keeps independent guard instances isolated; foreign cache evidence cannot activate this host.
6. **State over time** — Throttle failed reads for 60 seconds per host, bypassed at startup; successful reads clear the failure timestamp. Successful cache writes alone clear poison. Neither throttle nor failed reads refresh the ten-minute cache lifetime.
7. **Who wrote it** — Cache must name this host and contain successful status and valid read/write timestamps; mode 0600 limits access. Local cache is trusted host-local evidence, not a remotely supplied authorship marker. Preflight obtains remote evidence directly.

## Risks

Poison and failed-read throttles live in process memory. If disk removal fails and the process restarts, startup must still require a fresh remote read; callers must share guard state across later checks. Repair cache permissions or disk capacity when persistence fails. Strict clone discovery can still silently omit unreadable directories or corrupt overlay records and remains open here.

## Test plan

Run the two A1 suites through the host heavy-run queue. Cover non-me and unset ownership with failed writes and failed removal, successful poison recovery, per-host failure throttling and startup bypass, cache expiry, atomic file cleanup and permissions, bounded injected GitHub transport, read-only preflight hooks, executable discovery, checkout-root validation, sanitized output and returned CLI exit codes. Run `npm run check:standards` through the same queue.

Risk-to-test mappings (existing cases; execution remains required):

- **Startup after loss of in-memory state:** `we:scripts/lib/__tests__/daemon-host-guard.test.mjs` → `at-start-without-fresh standby even with fresh cache naming me` exercises the stateless decision with `atStart: true`, cache naming this host, and absent or expired remote evidence. Assert exactly `{ role: 'standby', reason: 'start-requires-fresh-read' }`. This proves persisted ownership alone cannot activate startup, independently of any remembered poison. In the same file, `remote returned error never writes cache and uses fallback only after start` and `remote throw never writes cache and uses fallback only after start` exercise resolver IO with old cached ownership: startup must return standby with reason `start-requires-fresh-read` and source `remote-failed`, and perform no cache writes. These are component assertions for the restart constraint; they do not simulate an actual process restart after failed removal.
- **Poison retained across subsequent checks sharing state:** `we:scripts/lib/__tests__/daemon-host-guard.test.mjs` → `failed cache write after fresh other-host read cannot reactivate this host on a later failed read` reuses the fixture's `state` object across calls. Assert the first call returns standby `owner-is-other-host`, invalidation is attempted once despite throwing, and the old cache naming this host remains unchanged. After `FRESH_READ_MS + 1`, a failed remote read must return exactly `{ role: 'standby', reason: 'cache-invalidated', source: 'remote-failed' }`. The companion case `failed cache write with unset owner then failed read stays standby` asserts the same retained-poison result for unset ownership.

## Duplicate admission

residual of host-guard PR

new residual cards from codex audit of host guard PR
