---
kind: task
status: open
scope: ["we:scripts/review-daemon.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Daemon interval knobs and load-flake-reverify manifest entry

The review and fix-dispatch intervals (120 s) are hardcoded: we:scripts/review-daemon.mjs:126 and we:scripts/reconcile-fix-dispatch-daemon.mjs:83. Make them configurable like pass-daemon --interval. Also WE_LOAD_FLAKE_REVERIFY_INTERVAL_MS in the load-flake-reverify plist is read by nothing, since the pass is not in we:scripts/daemon-manifest.mjs. Fold into the #3945 adoption.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
