---
bornAs: x1jcikc
kind: task
status: open
scope: ["we:vitest.config.ts", "we:vitest.shared.ts", "we:vitest.integration.config.ts", "we:vitest.maas-conformance.config.ts"]
dateOpened: "2026-09-07"
tags: []
---

# Cap vitest worker/thread count to stop per-invocation CPU oversubscription

we:vitest.config.ts / we:vitest.shared.ts had no pool/maxThreads/maxForks config, so a single vitest invocation defaults (via tinypool) to one worker per available CPU core (12 on a real host). we:scripts/readiness/heavy-admission.mjs (#3461) caps concurrent HEAVY COMMANDS at 2 host-wide, but never bounded worker threads WITHIN one invocation — two admitted vitest runs could grab up to 24 threads across the host cores, and the admission semaphore itself fails open on a 20-minute timeout (documented, observed live), so a 3rd concurrent run is real too. Fix: add an explicit maxThreads/maxForks cap (4) via we:vitest.shared.ts, applied in we:vitest.config.ts, we:vitest.integration.config.ts, we:vitest.maas-conformance.config.ts. Build-ready infra tuning, filed lightweight for tracking.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
