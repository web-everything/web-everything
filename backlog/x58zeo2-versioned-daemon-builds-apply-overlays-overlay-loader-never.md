---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-version-runtime.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-07"
tags: []
---

# Versioned daemon builds apply overlays; overlay loader never reports a fix adopted that is not in the version

Ruled card on #4222 (card 89 S5) finding we:scripts/lib/daemon-load-overlay.mjs:173: on a versioned clone the loader reports adopted:true when the in-tick build only built origin/main and never applied the requested overlay (overlaysApplied:false). Fold into card 89 S7: version builds apply registered overlays; until then the loader reports not-applied; S6 must not enable versioning on a clone that carries overlays. Dormant today (versioning off on every clone).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
