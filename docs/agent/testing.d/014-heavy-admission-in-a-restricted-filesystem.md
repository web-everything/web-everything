## Heavy admission in a restricted filesystem

Verify-daemon orphan fixtures must inject both `isAlive` and `groupAlive`: a fake dead PID
does not imply its host process group is gone. Signal-zero probes can return `EPERM` in a
restricted execution environment, which correctly retains the entry. The real-process adoption
test additionally requires permission to inspect child argv with `ps`.

Runner fixtures using synthetic PIDs must inject `identity` alongside `alive`: a successful
existence probe still checks process identity. Stamp fixtures must also inject `identityOf`
or supply both `runnerStart` and `runnerArgv`, so stamping cannot inspect a host process.

Keep production PID caller tests in a dedicated file using injected IO: the Vitest
`node:child_process` module mock does not reach `pid-alive.mjs` in this configuration.
Inject `buildLeaseSignalsFor`'s `isPidAlive`, composing `defaultIsPidAlive` with a fake
`kill` and `pidIdentity` with a fake `exec`. Assert the `ps` call as well as liveness
and reclamation outcomes; see `pid-identity-lease-reaper.test.mjs`.

PID identity probes return `true`, `false`, or `null`: callers must compare explicitly,
never truthiness-test `defaultIsPidAlive` or `probePid`. Only `false` establishes death;
unreadable identity or claim-runner command evidence retains a fresh claim's lane veto.
Test both wrapper and claim-runner wiring. Cover every changed `catch` branch with an
injected error: existence success and `EPERM` must consult identity (including false and
null verdicts), `ESRCH` proves death, and other errors remain unknown without identity IO.
Include invalid PID inputs and an identity probe that throws. A working Claude session
can retain `claude bg-spare` argv; require stored start/argv mismatch or other positive
death evidence to reclaim it. Legacy unstamped spares retain TTL recovery.

The host queue needs write access to the admission pool's parent as well as the pool:
`releaseLockDirIf` atomically renames a lock to a sibling tombstone before removal.
An `EPERM` on that rename is an admission infrastructure failure, not a suite result.
Keep the host queue; do not switch to a private pool or run tests directly.

