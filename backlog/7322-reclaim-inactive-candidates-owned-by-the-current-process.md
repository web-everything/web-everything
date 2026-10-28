---
bornAs: x8kj78e
kind: story
status: open
size: 3
dateOpened: "2026-10-27"
scope: ["we:scripts/lib/daemon-rebuild/candidate.mjs", "we:scripts/lib/daemon-rebuild/lease.mjs", "we:scripts/lib/__tests__/daemon-rebuild-stale-candidate.test.mjs"]
tags: [daemon, testing, prevention]
---

# Reclaim inactive candidates owned by the current process

A timed-out Git child can leave a locked candidate while its daemon owner remains alive. Extend ownership evidence to distinguish a finished attempt in this process from an active build, preserving every foreign or uncertain owner.

## Source

Follow-up requested by correctness/correctness in the advisory on [PR #5998](https://github.com/web-everything/web-everything/pull/5998), 2026-10-27 19:27:04 UTC, head `6a7130abebe6d24459d058c1cbef9b9f5b936d5f`. The reviewer marked the timeout scenario plausible and pre-existing, not a regression. This filing does not claim a live reproduction.

## Design

Use `ACTIVE_BUILD_TOKENS` from `we:scripts/lib/daemon-rebuild/lease.mjs` as same-process evidence: a matching same-host, current-pid candidate whose valid token is no longer active may be reclaimed. Require consistent persisted path, pid and token before that exception applies. Keep the existing provably-dead test for other local processes and preserve foreign-host or unknown ownership. Carry this evidence through takeover before the new lease replaces it; avoid duplicating eligibility rules across the lease and candidate modules.

## Acceptance

- A timed-out attempt leaves a locked own-clone candidate with the current pid and an inactive token; the next claim unlocks and removes that exact candidate before building its replacement.
- A current-pid candidate with an active token is preserved, including an aged lease. Foreign host, missing/corrupt lease, mismatched token/path/pid, other live pid and uncertain liveness remain protected.
- Successful same-process reclamation has an accurate diagnostic; it must not claim the owner pid died.
- Existing clone-prefix, parent-directory, lock-state and Git-failure boundaries continue to hold.

## Test and proof plan

Add a deterministic timed-out-child/next-claim case to `we:scripts/lib/__tests__/daemon-rebuild-stale-candidate.test.mjs`, using injected Git effects and real token-set membership. Pair it with an active-token preservation case and clean up token membership in all exits. Reproduce red before implementation and obtain green from the verification gate. Cover direct materialization and lease takeover, including retry after failed removal. Add the timeout/retry case to the daemon soak harness or document why it cannot be represented there.

## Non-goals

Reclaiming another host's candidate, treating permission errors as dead pids, or changing the existing filesystem fallback policy. Do not infer another process's inactivity from this process's token set.
