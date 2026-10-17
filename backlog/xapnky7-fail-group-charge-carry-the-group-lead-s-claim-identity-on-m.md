---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/build-dispatch-claim.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Fail-group charge: carry the group lead's claim identity on member claims

Residual of the PR #5453 send-back (one dead dispatch charged twice when its identity differs between observations). Orphan adoption keys a dead dispatch on its claim plus its run row; the fail-group pass keys it on the settled row plus the lead's surviving claim. If the orphan pass releases the lead claim on the same pass the run row was unreadable, the ledger holds only orphan:<claimedAt>; the next fail-group pass sees no lead claim and charges dispatch:<startedAt> as a second attempt. Member claims do not carry the lead's claimedAt, and we:scripts/conveyor/build-dispatch-claim.mjs was outside PR #5453's scope. Fix: stamp the lead's claimedAt on each member claim at acquire time and add it as an alias in we:skills-src/conveyor/build-dispatch-daemon.mjs's fail-group charge; regression: lead claim released while its row is unreadable, then a fail-group tick, charges once.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`: a new case charges `orphan:<lead claimedAt>` (row unreadable), releases the lead claim, then runs a fail-group tick on the settled row with only member claims left; it asserts `attempts: 1`. Red before, green after.
- [A2] **Must** — a later re-dispatch of the same group under a new lead claim is still charged as a new attempt.

## Non-goals

- [N1] Does not change how orphan adoption keys its charge or the ledger's alias rule (PR #5453 owns both).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the stamped value is the daemon's own ISO timestamp; n/a for external text.
2. **Truncated reads** — n/a: the claim meta is read whole from the lock store.
3. **Shared state files** — the stamp is written in the same claim reservation as the member's own meta; no second write.
4. **Fail closed** — a member claim with no stamp (written before this change) adds no alias, which is today's behaviour.
5. **Identity scoping** — the alias is per card number and per lead claim, so two groups never share it.
6. **State over time** — claims live at most one TTL; old claims without the stamp age out.
7. **Who wrote it** — only the build-dispatch daemon acquires these claims; n/a for actor checks.
