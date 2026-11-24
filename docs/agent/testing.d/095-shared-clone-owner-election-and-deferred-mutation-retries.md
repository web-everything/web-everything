## Shared clone owner election and deferred-mutation retries

`daemon-clone-single-owner.test.mjs` pins live-key election using stable string ordering,
reader-clock heartbeat ages with a 30-second future-skew bound, and monotonic persisted epochs.
Election and rebuild execution share a coordination mutex, independent of the reader/writer
locks. A live local process retains that fence through a paused event loop; a provably dead
process permits reclamation. Unknown lock liveness or corrupt/exhausted epochs defer rebuilds;
the operator must inspect and repair coordination evidence before rebuilding resumes.
`daemon-rebuild-request-failures.test.mjs` distinguishes explicit rebuild failures from neutral
job/lock outcomes, including persisted request retention. `daemon-self-sync-mutation-due.test.mjs`
requires failed/refused mutations to remain pending and retry on the next tick; only a completed
mutation enters handled-ID state. Run these and the affected lock/self-sync regressions through
`node scripts/readiness/heavy-admission.mjs run -- npx vitest run <scoped files>`.

