---
bornAs: xmhyk6a
kind: story
size: 2
parent: "xf7ax93"
status: open
scope: ["plateau:tools/drain-daemon/daemon.mjs", "plateau:tools/drain-daemon/lib.mjs", "we:scripts/lib/pr-events.mjs"]
dateOpened: "2026-09-27"
tags: []
locus: plateau-app
relatedTo: ["2743", "3070"]
---

# Drain daemon consumes the PR-events feed and lengthens its poll when healthy

Slice 1 follow-up (webhooks-not-polling). Slice 1 wakes the drain only indirectly: the review daemon forwards drain-relevant events to the drain daemon's POST /nudge (makeDrainNudgeForward in we:scripts/lib/pr-events.mjs). The drain still polls every DRAIN_DAEMON_INTERVAL_SEC=60 and runs we:scripts/merge-ai-prs.mjs outside gh-throttle, a top GraphQL spender. Wire withPrEvents-style event-aware sleep into plateau:tools/drain-daemon/daemon.mjs directly (role drain), so its interval lengthens to ~10 min while the feed is healthy and falls back to 60s when stale. Relates to #2743 (event-driven wake) and #3070 (choose the waker).

Re-parented 2026-10-08 from #4075 to the event-driven daemons epic (xf7ax93): this is step 1 of ruling E6, built on the shared cursor + dirty-PR foundation (xlta0x5, in flight in the event-foundation-drain lane; add it to `blockedBy` once it lands). The drain wakes for one dirty PR; per we:docs/agent/platform-decisions.md#event-driven-land-is-wake-only a ready-to-land event is a hint, never an order, and the drain re-checks every gate live and keeps the `blockedBy` ordering. Measure with the 2026-10-08 event-latency script: drain first look p50 140 s to under 15 s; `drainForwardFailed` 23 to 0.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
