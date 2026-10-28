---
bornAs: x5osb5c
kind: story
status: open
size: 3
dateOpened: "2026-10-27"
scope: ["we:scripts/lib/daemon-rebuild/candidate.mjs", "we:scripts/lib/daemon-rebuild/lease.mjs", "we:scripts/lib/daemon-rebuild/rebuild.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/__tests__/daemon-rebuild-stale-candidate.test.mjs"]
tags: [daemon, testing, prevention]
---

# Preserve candidate reclaim logs through lease takeover

Carry successful reclamation evidence through lease takeover and test the emitted candidate path on both smoke paths. Direct materialization coverage cannot detect a lost logger or a reclaim result discarded before smoke begins.

## Source

Follow-up requested by the advisory on [PR #5998](https://github.com/web-everything/web-everything/pull/5998), 2026-10-27 19:27:04 UTC, head `6a7130abebe6d24459d058c1cbef9b9f5b936d5f`. Combines correctness/test-coverage, codex-correctness/coverage, and the later-round simplicity card suggestion about smoke logging. The advisory accepts that head and requires human review; this card records future work without changing that verdict.

## Design

At `we:scripts/lib/daemon-rebuild/lease.mjs`, takeover calls `removeCandidate` before replacing the old lease. Preserve or emit its successful reclaim evidence through the existing rebuild logger. Keep the message tied to the actual reclaimed path, including when subsequent materialization finds nothing left to reclaim. Inspect the caller in `we:scripts/lib/daemon-rebuild/rebuild.mjs` and both branches of `smokeAndAdopt` in `we:scripts/lib/daemon-rebuild/smoke.mjs`.

## Acceptance

- Named integration cases exercise stale-lease takeover followed by the proven-tree (`dispatchOnly`) path and the full-smoke path, asserting the injected logger contains `reclaimed stale candidate worktree` and the exact old path.
- Separate direct-materialization cases on both smoke paths defend forwarding the logger to `materializeCandidate`.
- Foreign-host, live/unknown-owner, and failed reclamation cases emit no successful-reclaim message. An omitted optional logger remains supported.
- Preserve the existing host, lease, path and liveness checks and the current removal-failure policy.

## Test and proof plan

Extend `we:scripts/lib/__tests__/daemon-rebuild-stale-candidate.test.mjs` with the real lease-to-smoke sequence and injected Git/smoke effects. Existing anchors are `lease takeover preserves reclaim evidence for a %s` and `reclaims before adding and reports it via log`; neither asserts takeover logging through smoke. Demonstrate the takeover logging test red before changing source, then green through the verification gate. Use the approved mutation harness to check each smoke call's logger forwarding independently. Add a daemon soak replay or justify an explicit waiver at implementation time.

## Non-goals

Changing reclamation eligibility, filesystem fallback behavior, or review labels. Same-process timeout recovery is separate work.
