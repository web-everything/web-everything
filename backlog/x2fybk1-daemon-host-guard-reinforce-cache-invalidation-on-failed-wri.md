---
kind: story
size: 2
status: open
dateOpened: "2026-11-16"
tags: []
related: ["daemon-host-guard"]
---

# Daemon ownership: fresh source reads and opaque local identity

PR #6945 follows R970 and R971: every role resolution obtains a new successful
ownership read. Errors, timeouts, unexpected records and missing ownership leave
the daemon on standby. Cached ownership, throttles, locks and fences are removed.

## Acceptance

- [A1] **Executable** — run `npm run test:unit --` with the repo-relative paths for
  `we:scripts/lib/__tests__/daemon-host-guard.test.mjs` and
  `we:scripts/operations/__tests__/daemon-preflight.test.mjs` (omit the locus prefix in shell arguments).
- A fresh read naming the local ID activates; another ID or unset owner stays standby.
  Success followed by failure must never reuse the earlier grant, including after restart.
- Ownership sources implement `readOwner(): Promise<{host, version}>`. The GitHub
  adapter reads `host` on `daemon-host-owner`, pinning contents to the observed commit.
- Generate a random UUID once in `~/.claude/host-id`, mode 600. Publish without
  overwriting another process's ID. Malformed or inaccessible identity fails closed.
- Deprecated aliases are migration constants only; a fresh legacy owner value must
  match the locally established alias.
- Preflight reads existing identity without provisioning it, uses the same resolver,
  reports unreadable ownership as a failed check, and continues unrelated checks.
- Clone discovery errors remain explicit failures; valid stale overlays and sidecars
  remain excluded.

## Non-goals

- [N1] Wiring the guard into daemons or changing the hook registry's discovery policy.
- Ownership leasing or stopping an already-running daemon after a remote handoff.

## Edge cases

1. Owner contents must be a canonical base64 encoding of one ID, optionally ending
   in LF or CRLF. Unknown values, extra lines and invisible characters fail closed.
2. GitHub, local-name migration, git and SSH subprocesses retain 15-second and 1 MiB
   limits. Resolver reads time out; expired or backwards elapsed time fails closed.
3. Identity publication uses a unique mode-600 temporary file and an atomic no-overwrite
   link. A concurrent initializer reads the winner. No ownership files are persisted.
4. Read-only preflight reports a missing ID as invalid input; provisioning belongs to
   guard initialization. Symlinks, non-files, oversized IDs and permissive modes fail closed.
5. Repeated and concurrent invocations each read their source independently.

## Test plan

The guard suite covers fresh local/foreign/unset ownership, unexpected source shapes,
thrown transport failures, stalls, elapsed-time bounds, repeat calls, identity persistence,
permissions, malformed files and migration. The preflight suite retains strict discovery,
output sanitation, executable detection, checkout-root validation and subprocess bounds.
The registered `host-handoff-cache-write-race` soak now exercises two opaque identities
through success, handoff, outage, unset and recovery with a fresh read on each call.
Obsolete cache, lock and fence scenarios are deleted.

## Duplicate admission

Residual of host-guard PR; R970 replaces cache reinforcement with removal.
