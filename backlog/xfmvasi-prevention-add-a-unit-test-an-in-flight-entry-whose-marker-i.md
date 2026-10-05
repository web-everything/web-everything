---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:skills-src/conveyor/verify-daemon.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:skills-src/conveyor/__tests__/verify-daemon.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a unit test: an in-flight entry whose marker is green, or whose sha differs from HEAD, is kil… (from web-everything/web-everything#3972 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/verify-dispatch.mjs:478` — Add a unit test: an in-flight entry whose marker is green, or whose sha differs from HEAD, is killed or released. Alternatively, sweep the registry independently of the lane scan, so orphan handling does not depend on the pending-marker filter.
2. `we:skills-src/conveyor/verify-daemon.mjs:273` — When a code change is detected, stop launching new gates (or cap the wait at a deadline, then kill and restart). Add a test that the restart happens within a bounded number of ticks under continuous load.
3. `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:834` — Add a deterministic case to the named superseded-run test with VERIFY_DISPATCH_KILL_SUPERSEDED absent, asserting the process-group kill; verify that changing the guard to === '1' makes that case fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3972@b85371716ad65f2bdc42164f035fa9a98dad812d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
