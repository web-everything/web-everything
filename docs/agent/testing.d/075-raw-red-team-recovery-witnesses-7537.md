## Raw red-team recovery witnesses (#7537)

Recovery fixtures persist the panel read as a `review-pr` run and inject the scorecard store;
`status.loopPayload` is deliberately truncated. Bind abandonment to raw writer bytes and seat/run
evidence, then test mutations before queued admission. Never normalize the status in a reader.
Inject raw witness/probe failures directly for liveness refusals; do not infer them from normalized drain flags.
Only a raw `running` writer can infer an interrupted failure from a single failed seat and no result.
A dead `queued` writer with an existing failed seat and no result must refuse planning, abandonment and admission
without spending either marker; test null/missing results and zero/missing retry counts alongside running recovery.
The dead-owner and skip-settlement breaks are discovered from disk and run with `vitest.soak.config.ts` using the shared repo registry.
Status-write claims record the holder's PID, birth time, host and PID namespace. The recovery-witness
fixtures cover reused PIDs in abandonment and every ordinary status write, live and unreadable
identities, initialization grace, legacy numeric claims, and post-move identity verification.
The dead-owner soak includes a 24-hour-old claim whose numeric PID is alive but whose birth time
belongs to a dead owner; recovery must dispatch and publish exactly once. Preserve the numeric
first line for older writers. Legacy claims with a live PID and no birth time remain protected;
inspect the owner before manually removing such a claim, since age alone cannot prove it dead.
