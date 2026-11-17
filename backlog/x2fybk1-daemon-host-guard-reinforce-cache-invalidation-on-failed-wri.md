---
kind: story
size: 2
status: open
dateOpened: "2026-11-16"
tags: []
related: ["daemon-host-guard"]
---

# Daemon ownership: fresh evidence and strict preflight discovery

R970 supersedes the ownership-cache design in PR #6945. Every decision now reads the ownership source; failures, timeouts, malformed responses and stale or future evidence give standby. There is no stored ownership, read throttle, cache lock or fence to recover.

R971 replaces machine names with a random UUID v4 stored once in `~/.claude/host-id`, mode 0600. Concurrent initialization publishes a complete file with an exclusive hard link; other initializers read that winner. Unreadable, malformed or insecure existing IDs are never overwritten. Legacy values are isolated in migration constants and accepted only when the local legacy alias matches.

## Acceptance

- [A1] **Executable** — the guard and preflight suites in `scripts/lib/__tests__/daemon-host-guard.test.mjs` and `scripts/operations/__tests__/daemon-preflight.test.mjs`.
- A fresh successful source read naming this ID is active; other ownership or an unset owner is standby.
- Every invocation performs its own source read. Exceptions, rejection, timeout, malformed data and late completion cannot reuse previous authorization.
- The GitHub source implements `readOwner(): Promise<{host, version}>`. It reads `host` at the commit returned by the `daemon-host-owner` ref, preventing a branch change between the two requests from mixing versions.
- Preflight uses the same resolver, reads existing identity without initializing it, and reports identity/ownership errors as failed role checks while continuing all other probes.
- Strict clone discovery reports missing/unreadable directories and corrupt/unreadable/invalid overlay records. Valid stale records and sidecars are intentionally excluded.

## Non-goals

- [N1] No daemon call sites are wired in this PR. Hook-registry discovery remains permissive; only preflight uses strict discovery.
- No ownership lease, remote locking, caching or automatic owner-branch update.

## Edge cases and tests

1. **Untrusted text and normalization:** UUIDs compare exactly. Owner files allow one LF or CRLF terminator; malformed base64, embedded whitespace, control characters and other unexpected values are unreadable. Preflight sanitizes terminal output.
2. **Bounds:** GitHub, migration alias discovery, git and SSH subprocesses have 15-second timeouts and 1 MiB output limits. Identity reads are bounded to 39 bytes. Resolver deadlines also reject late successful completion.
3. **Shared identity creation:** concurrent processes get one published token. Invalid files, symlinks, directories, oversized data and incorrect modes fail closed; creation failures never use an OS alias as the primary ID.
4. **Recovery:** success, handoff, failure and recovery each require a new source read. Timed-out promises cannot populate remembered state.
5. **Preflight:** missing identity stays missing; valid identity remains unchanged. Returned/thrown source errors fail the role check and preserve later diagnostics.

## Verification

The registered `host-handoff-cache-write-race` soak retains its historical ID but now exercises the source adapter, handoff, repeated offline checks, fresh recovery and production preflight diagnostics. Obsolete cache/lock/fence scenarios were removed.

Run affected suites through heavy admission and the diff-selected standards gate. The structural subprocess-bound prevention card remains separate; the cache-throttling follow-up is superseded by R970.

## Operational limits

Initialize the local ID with `getThisHost()` before running read-only preflight, then put that token in the owner branch. Only the two migration constants accept a local legacy alias. Never copy the identity file between machines. Fresh reads are snapshots, not distributed leases: callers must check at their intended admission point. This PR does not define running-daemon handoff semantics.
