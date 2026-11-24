## Drain freeze read recovery

The named failed-cache-replacement regression seeds a clear, observes a live freeze while replacement fails, then forces a transient read before TTL expiry. Failed writes remove old evidence and block reuse in-process even when removal fails; only a successful cache write restores eligibility.

`freeze-last-good.test.mjs` exercises transient-read retries and persistent successful reads with an injected clock, sleep and temporary cache path. Reused evidence must keep its original fetch timestamp: rewriting it during reuse would let an outage extend a cached clear indefinitely. Expired, future-dated, corrupt or missing evidence holds the line. Permanent errors never reuse the cache. `freeze-unreadable-hold` retains the `red-main-hold` skip kind and `redMainHold` flag so pass-level admission and PR-comment suppression still apply. Run these tests through heavy admission.
