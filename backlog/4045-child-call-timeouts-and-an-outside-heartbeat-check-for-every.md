---
bornAs: xi58xoz
kind: story
size: 8
parent: "3383"
status: open
dateOpened: "2026-09-23"
tags: []
scope: ["we:skills-src/conveyor/pass-daemon.mjs", "we:skills-src/conveyor/__tests__/pass-daemon.test.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells/daemon-silent.mjs", "we:scripts/conveyor/health-smells/__tests__/daemon-silent.test.mjs", "we:scripts/conveyor/health-smells/__tests__/host-smells.test.mjs", "we:scripts/conveyor/__tests__/daemon-child-budgets.test.mjs"]
---

# Child-call timeouts and an outside heartbeat check for every resident daemon

Timeouts and external health smells already cover parts of this incident class, but the resident pass runner still waits indefinitely for a child that never exits, and the silence smell skips a lease with no activity history. Complete bounded child execution and independent observation through the existing pass runner and health-watch path. Reuse the existing lag, owed-work and authentication smells rather than create a second alert service. Size 8 reflects the runner, resident callers, independent observer and process-boundary tests.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:skills-src/conveyor/__tests__/pass-daemon.test.mjs`: add a child that stays alive past an injected short deadline; assert bounded termination, a named timeout outcome, timer cleanup, and continued heartbeat/release behavior. Current spawnPassOnce has only a post-exit pipe grace timer, so this case fails before the runtime deadline lands.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/health-smells/__tests__/daemon-silent.test.mjs`: an alive lease with a stale heartbeat and no historical tick/log record produces an observable stale-heartbeat finding instead of being skipped. A fresh lease gets a bounded startup grace; unknown or malformed heartbeat evidence is reported as unknown, not healthy.
- [A3] Add we:scripts/conveyor/__tests__/daemon-child-budgets.test.mjs (new): enumerate resident entrypoints and their tick subprocess callers, proving each blocking call has a finite configurable timeout and each asynchronous long-lived child has a wall deadline, bounded termination and drained output. Include a child that ignores graceful termination and one whose descendant holds stdout open; no success or empty queue may result from timeout.
- [A4] Exercise health-watch from a separate process while the monitored fixture event loop is blocked. Confirm one durable health episode and the existing notification path, then recovery without repeated notifications every tick. Preserve lag, owed-but-undispatched and auth-error findings with regression fixtures through the same health pipeline; legitimate live work/cap refusals must not count as a dispatch stall.
- [A5] Keep existing signal thresholds configurable and document observed evidence versus missing telemetry. Do not claim running-revision lag from checkout HEAD alone; that remains distinct from the running-revision publication work in #4051.

## Non-goals

- [N1] No automatic clone rollback, process restart or destructive lease reclamation in response to these alerts.
- [N2] No new fleet UI or alert transport, and no implementation of #4051 running-revision telemetry in this card.

## Edge cases this change must handle

1. **Untrusted text** — Child output and refusal strings are bounded diagnostic data; escape notifications and never execute suggested commands from logs.
2. **Truncated reads** — Output caps, partial JSON, killed reads and missing log segments produce explicit failed/unknown evidence, not an empty queue.
3. **Shared state files** — Reuse health-watch episode persistence and lease readers; observer findings must not mutate the monitored lease or overwrite newer heartbeat state.
4. **Fail closed** — Timeout/spawn failure is a failed tick with a named cause; missing heartbeat/activity evidence cannot certify health.
5. **Identity scoping** — Correlate daemon, clone, process/session incarnation and repository; PID reuse or a different clone must not inherit a prior healthy episode.
6. **State over time** — Cover startup grace, clock skew, long legitimate cadence, heartbeat advancing while dispatch stalls, restart during an episode and notification deduplication.
7. **Who wrote it** — Use the supervisor-owned lease and configured log sources; a child printing a healthy-looking line cannot replace heartbeat evidence. No receive endpoint is added.

## Grounding

- we:skills-src/conveyor/pass-daemon.mjs:245 spawns the pass without a runtime deadline; :278 only bounds waiting for pipe close after exit.
- we:scripts/conveyor/health-smells/daemon-silent.mjs:47 constructs activity memory, :49 skips when absent, and :57 already recognizes stale-heartbeat hangs when activity exists.
- we:scripts/conveyor/health-smells/clone-behind-main.mjs:22 evaluates checkout lag; it does not establish the running module revision.
- we:scripts/conveyor/health-smells/daemon-owed-no-dispatch.mjs:29 defines duration/count thresholds and :49 checks the streak; we:scripts/conveyor/health-smells/bad-credentials.mjs:25 counts recorded authentication errors.
- we:scripts/lib/daemon-self-sync.mjs:452 already supplies a timeout and SIGKILL for its diff child; we:scripts/lib/__tests__/daemon-self-sync.test.mjs:697 tests existing self-sync subprocess bounds.
- we:scripts/conveyor/health-smells-notify-list.mjs:48 already includes daemon-silent; this is completion of coverage, not a new watchdog from scratch.
