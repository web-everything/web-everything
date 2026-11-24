## Suspended mandatory-referral handoff (R746)

A `review-pr` run pending an effect at `mandatoryReferrals` is incomplete panel evidence,
but a recorded referral ruling on its unchanged head can wake that exact pending effect.
`review-ruling-resume.test.mjs` covers in-place replay, unchanged effect keys, no new panel,
and the separate `RESUME_MAX_ATTEMPTS` budget. Do not route existing `resumeOf` persistence
retries through this path: they retain their original retry accounting.
The judge facts reader observes the shared run store; hermetic facts fixtures must inject
`findSuspendedRuns`. `suspended-referral-run.test.mjs` covers the bounded scan and window
cascade; judge facts IO tests cover durable per-run alert claims and ruled-finding suppression.
Alert claims never expire automatically: uncertain publication requires operator inspection
of `referral-judge-alert-claims` in the shared runs directory, rather than a liveness probe.


