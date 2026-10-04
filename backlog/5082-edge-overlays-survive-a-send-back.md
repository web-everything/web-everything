---
bornAs: xxkfzfp
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-rebuild.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Edge overlays survive a send-back

Live 2026-10-03/04: PR #3881's overlay vanished from the wev-review-daemon overlay list when the PR was sent back for changes (not merged). #3794 then sat blocked on scope-read-failed for about 1.5 h until the overlay was re-added by hand. Operator asked 'Anything not captured slowing us down?'. Fix: we:scripts/daemon-overlay.mjs and we:scripts/lib/daemon-rebuild.mjs remove an overlay only on merge, close, or a real merge conflict, and log every removal with its reason. Done when: (1) a send-back never removes an overlay (test red-green); (2) removal happens only on merge, close or real merge conflict; (3) every removal writes a log line with its reason; (4) replaying the #3881/#3794 sequence keeps the overlay.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
