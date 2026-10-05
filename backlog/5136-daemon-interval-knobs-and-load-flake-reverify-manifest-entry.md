---
bornAs: xj1zosg
kind: task
status: resolved
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/__tests__/review-daemon-interval.test.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-10-05"
dateResolved: "2026-10-05"
tags: []
---

# Daemon interval knobs and load-flake-reverify manifest entry

The review and fix-dispatch intervals (120 s) are hardcoded: we:scripts/review-daemon.mjs:126 and we:scripts/reconcile-fix-dispatch-daemon.mjs:83. Make them configurable like pass-daemon --interval. Also WE_LOAD_FLAKE_REVERIFY_INTERVAL_MS in the load-flake-reverify plist is read by nothing, since the pass is not in we:scripts/daemon-manifest.mjs. Fold into the #3945 adoption.

## Done when

Delivered half (2026-10-05):

1. **Executable** — `npm run test:unit` on we:skills-src/conveyor/__tests__/review-daemon-interval.test.mjs passes: the review daemon's interval reads `--interval-ms`, then `WE_REVIEW_DAEMON_INTERVAL_MS`, then the unchanged 120000 default, floored at 10000 (fails on the pre-change source, 20/21 red).
2. **Already landed** — `load-flake-reverify` has a `we:skills-src/conveyor/daemon-manifest.mjs` entry whose interval reads `WE_LOAD_FLAKE_REVERIFY_INTERVAL_MS` (default 300000), covered by `we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs`. Nothing left to do here.

Deferred: the fix-dispatch interval knob in `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs` waits until #3982 lands (that file is in flight there). Keep this card open until then.
