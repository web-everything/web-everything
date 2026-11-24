## Prepare failure diagnosis and release

`we:scripts/conveyor/prepare-failure-policy.mjs` records evidence and cause per attempt in the
coordination-root prepare failure ledger. Only observed rate-limit/network faults permit two automatic
retries; wrapper errors, timeouts and missing output alone are unknown. Unknowns reserve a prevention
landing job once per cause and stay held. A pending/failed filing is not a landed card: inspect its
record and job output, never blindly respawn it.

Release through `we:scripts/conveyor/prepare-failure-releases.json`: cite the exact attempt, known cause,
report evidence and full fix commit. The daemon verifies the commit is in its own ancestry before
applying the data. A later attempt is not covered by an earlier release. Route entries use target
`route:prepare` and exact scorecard `handle:scoredAt` keys; every failed probation attempt must be covered
before the latched route returns. Neither elapsed time nor a later successful run clears that latch.
The incident report `reports/2026-09-30-prepare-failures-root-causes.md` distinguishes worker cause from
claim retirement: dead-session cleanup frees capacity but does not prove why authoring failed.

Prepare PR identity is shared in `we:scripts/conveyor/prepare-pr-match.mjs`: same-repo branches
accept one uniqueness letter after the card number (or `bornAs`), with the `WE #<num>: prepare`
title as a fallback. That fallback is refusal grade only (`isPreparePrFor`): it may refuse a launch,
never drive a write. The status reader, whose result drives retirement, holds and the stamp worker,
uses the write-grade `isLanePreparePrFor` (lane branch required). Test every write path with a
title-only PR outside `lane/` and assert no stamp, hold or retirement comes from it.
An ended attempt frees its prepare slot even while its PR is OPEN (that PR refuses the re-launch):
test cap-many ended OPEN-PR cards and assert a clean card still launches.
Probe OPEN and MERGED PRs without stamps: neither is an unstamped failure.
The launch guard must also run without a surviving claim, and refuse when PR listing throws.
Merged launch refusals measure age from `mergedAt`, falling back to `closedAt`, then `createdAt`,
under `prepare.mergedGuardHours` (default 24; 0 disables only the merged refusal). They apply even
without surviving dispatch history. Probe the time boundary with an injected clock, including a PR
created over 24 hours ago but merged 21 minutes ago. Scope drift on a recently merged prepare
records a "scope moved after prepare" note for the build step in the refusal and its persisted
bookkeeping; it must never dispatch another prepare within the window. A card the planning pre-scan
skips for that merge carries the same note and persists the same `prepareRefusals` record as a
launch refusal; assert both on the planning tick, not only on a merge that appears after planning.
A needs-you park in the newest ledger record refuses the launch while it is `held` and not `completed`.
Any one of three things clears it: a stamp on main (it completes the record, so a hand stamp resolves
the park), explicit `releasedAt`/`releasedBy` metadata, or a reviewed release of that exact attempt in
the releases store. Cover each clearing path, and an older park under a newer record, so an operator's
hand stamp never re-parks the card (the stale-reprepare livelock).
tick-core offers at most two item prepares and cannot see these launch refusals. The daemon keeps a
refused card out of the plan, and out of a clean lead's prepare group, for `PREPARE_REFUSAL_HOLD_MS`,
then checks it again. Build-backoff cards and group members in flight are held out the same way.
Every group member passes the same launch admission as its lead (`refusePrepareLaunch`); test a member
that was never refused before and has its own open PR. When nothing else tracks a card refused for its
own lane prepare PR, the daemon reads THAT PR once per refusal (`prNumber`). A finished but unstamped
result (open, with sections, no stamp, judged against the stamp a re-prepare replaces) goes to stamp
recovery, and later reads stay on that PR while its hold stands; anything else
stays a refusal that takes no prepare slot and places no hold. Test that capacity
rule with the REAL `planTick`, never a stub that offers more picks than the cap: two refused cards and
a clean third, across ticks.

Stamp-recovery reservations do not expire. A terminal recovery error is recorded in its dispatch log,
classified by the daemon, and cannot spawn again without a remaining transient budget or a cited fix.
A new starting marker prevents the previous failure from being mistaken for the newly running job.
Historical probation evidence can accompany an item release under its exact `probationAttempt` key;
this improves the recorded diagnosis but does not authorize a route release.

Red-draft inactivity in `we:skills-src/conveyor/build-dispatch-daemon.mjs` is measured from the later of the current head commit’s committed date and the builder effect’s `lastSeenLiveAt`. Never age recovery from PR `updated_at`: labels, check reruns and advisory notes refresh it without author activity. Replay a recent PR metadata update with old author evidence, and separately assert that a live author, a recent commit or recent live observation prevents recovery. Missing both usable timestamps fails closed.

### Preparation terminal handoff

Prepare probation launches carry the original dispatch run ID and effect key into the terminal writer.
A stamp on main invalidates prepare guards and holds before build planning; a positively live worker
still retains ownership. Probe with an in-flight run on disk, duplicate terminal delivery, a restarted
reader, and a stamped card at the next daemon tick. Held dispatch reads must not invoke the full planner.
Use the integration Vitest config for we:scripts/operations/__tests__/dispatch-lane-integration.test.mjs;
the default config excludes that file. Keep dead-PID and unknown-session crash recovery tests.

