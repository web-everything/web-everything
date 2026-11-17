---
kind: story
size: 3
status: active
scaffoldedBy: "daemon-host-launch-gate"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/operations/daemon-host-gate.mjs", "we:scripts/operations/__tests__/daemon-host-gate.test.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# daemon-host-gate reinforce: kill the daemon process group on revoke; make the owner-file override impossible in production

Keep daemon ownership tied to the shared owner record and stop every member of
the gated process group when ownership is revoked. PR #6949 adds group signaling,
cleanup after the leader exits, and CLI tests for the existing test-only flag.
Remaining work removes the file override from the production entrypoint and pins
the guarantee that owner reads neither trust nor write the production cache.

## Acceptance

- [A1] **Executable** — run the scoped unit-test command for
  `we:scripts/operations/__tests__/daemon-host-gate.test.mjs`. It
  includes real Node and shell leaders with background workers. Revocation,
  wrapper shutdown and leader exit leave no running group member, including a
  worker that ignores SIGTERM. Implemented by the PR #6949 repair.
- [A2] **Must refuse** — the production CLI rejects WE_DAEMON_HOST_OWNER_FILE
  regardless of the test-only flag, exits 2 and never executes its command.
  Move local-file rehearsal into an explicit test fixture using injected
  readRemote. Until that migration, the named CLI refusal tests pin the current
  requirement that the flag must be exactly `1`.
- [A3] **Must read shared ownership** — tests inject a stale active cache and
  remote standby/error results, observe a remote read on each poll, and assert
  neither cache reads nor cache writes occur in the gate's production path.
- [A4] **Prevention** — add a standards fixture rejecting an active backlog card
  with unfinished Acceptance placeholders; a fully specified active card passes.

## Non-goals

- [N1] No host handoff protocol, launchd cadence or owner-record format change.
- [N2] Process groups do not contain workers that deliberately create another
  session/group; those require a separate supervision contract.

## Risks

- A leader may exit before its workers: canceling its grace timer alone leaks them.
- An inherited environment variable may select local ownership in production.
- A cache shortcut may revive stale ownership or write shared state unexpectedly.
- An unfinished active card can conceal a missing executable acceptance check.

## Test plan

- A1 **capability (Red before the PR #6949 repair)**: real processes, readiness handshake, revoke/TERM/INT/HUP/wrapper-exit and
  early leader exit; poll descendant liveness with a bounded deadline and always
  kill test-owned processes in cleanup. Also retain the grace-escalation unit test.
- A2 **capability (Red today for flag `1`)**: subprocess CLI tests cover missing, empty, `0`, `true` and `1` flags with an
  owner file naming this host; rejected cases exit 2 and leave the command marker absent.
- A3 **preservation (GREEN today)**: inject observable cache/remote dependencies;
  fail if a cache is consulted or mutated, and cover thrown remote reads as well
  as explicit standby. Mutation proof: wire the real cache into pollRole and
  require the preservation test to fail.
- A4 **capability (Red today)**: standards positive/negative fixtures map unfinished acceptance to rejection.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — argv stays an array; environment flags use exact equality.
2. **Truncated reads** — malformed or unreadable ownership never grants a launch.
3. **Shared state files** — the gate neither trusts nor writes the owner cache.
4. **Fail closed** — rejected overrides never spawn; failed ownership reads follow
   the existing bounded running grace and standby rules.
5. **Identity scoping** — signal only the detached daemon's process group.
6. **State over time** — clean up surviving workers even after their leader exits.
7. **Who wrote it** — local test files must not become production ownership evidence.
