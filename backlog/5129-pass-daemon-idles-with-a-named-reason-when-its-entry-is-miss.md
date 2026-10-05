---
bornAs: x26el1a
kind: task
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Pass-daemon idles with a named reason when its entry is missing from the clone

The load-flake-reverify launchd job crash-looped every 10s because wev-review-daemon lacked #3945. It should idle with a named reason, not crash-loop.

## Done when

1. **Executable** — run from the WE checkout to prove the CLI stays alive with `manifest-entry-missing`, sleeps between checks, and preserves valid-entry startup and malformed-entry refusal:

   ```bash
   npm run test:unit -- skills-src/conveyor/__tests__/pass-daemon.test.mjs
   ```

2. **Must** — a missing entry idles before lease acquisition or pass execution; update the clone and restart to load a newly registered entry.
3. **Must** — malformed manifest configuration/data still fails closed; neither source paths nor docs/config/data paths supplied as pass names bypass the manifest allowlist.
