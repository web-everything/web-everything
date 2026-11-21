---
bornAs: x6pbhd0
kind: task
status: open
scope: ["we:scripts/conveyor/soak"]
dateOpened: "2026-11-21"
tags: []
---

# Reinforce #7266: soak wrappers miss quarantine paths, PR gate and hermetic git env

#7266 reinforce, quarantine-path miss FIRST (confirmed): soak wrappers miss quarantine paths; soak drops the PR gate and hermeticGitEnv; timeouts are looser than needed; progress-board exit-code assertions; git-diet execFileSync-only hook. Source: build-queue 22:34 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `checks quarantine paths before running soak work` in `we:scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs`: Parameterize active, expired and absent quarantine fixtures; assert active quarantines take the documented skip path before starting work, expired quarantines produce the required expiry failure and absent quarantines run the case. A skipped case must remain distinguishable from a passing executed case.
- [A2] **Executable** — Planned `retains PR gate and hermetic Git environment` in `we:scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs`: Drive the wrapper with a refusing PR gate and assert no soak child starts. With admission granted, run a real temporary Git repository under hostile inherited Git configuration and assert the child receives hermeticGitEnv and cannot read or modify an outside repository.
- [A3] **Executable** — Planned `bounds wrapper timeout and reports incomplete execution` in `we:scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs`: Use a controlled child that exceeds the configured timeout; assert bounded termination, no surviving fixture child and an explicit timeout failure rather than a success or an indefinitely waiting wrapper.
- [A4] **Executable** — Planned `propagates progress-board exit codes` in `we:scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs`: Parameterize successful and failed progress-board child exits; assert the wrapper preserves each exit code and never reports success for a failed board command.
- [A5] **Executable** — Planned `enforces git-diet hook beyond execFileSync` in `we:scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs`: Exercise the covered non-execFileSync subprocess APIs with both a forbidden Git invocation and an allowed control; assert every forbidden invocation is blocked before Git runs and each allowed control executes. Include a real fixture subprocess so a stubbed exit alone cannot satisfy the hook assertion.

Run `npm run test:unit -- <test-file>` through the host heavy-run queue using the repository-relative path after the `we:` prefix above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No blanket soak timeout relaxation.

## Edge cases this change must handle

1. **Untrusted text** — Process and git output remain data.
2. **Truncated reads** — Missing gate output cannot count as a pass.
3. **Shared state files** — Use hermetic fixture state for soak wrappers.
4. **Fail closed** — Quarantine or PR-gate failures prevent a passing soak.
5. **Identity scoping** — Bind wrapper results to the tested PR and fixture.
6. **State over time** — Cover timeout and subprocess completion boundaries.
7. **Who wrote it** — Only wrapper-observed exit codes establish success.

## Duplicate admission

new card from build-queue CARD line
