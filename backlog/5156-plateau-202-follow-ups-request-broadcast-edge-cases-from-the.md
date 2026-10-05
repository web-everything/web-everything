---
bornAs: xnim2wm
kind: story
size: 3
status: open
scope: ["plateau:src/wip/", "plateau:scripts/lib/request-intake.mjs", "plateau:scripts/lib/request-store.mjs", "plateau:src/diagnostics/"]
dateOpened: "2026-10-05"
tags: []
---

# Plateau #202 follow-ups: request/broadcast edge cases from the review loop

Operator approved #202 on 2026-10-05 with remaining findings as this card. Fix in the WIP glance request and broadcast flows: (1) request-advance marks a request Released on any later Plateau deploy and misses build PRs that merge between observations; (2) request-intake treats conditional assent as permission when auto-filing is off, and retries can file a duplicate card before the checkpoint; (3) requests stopped with openPr disabled never resume when re-enabled; (4) broadcast text clears before the laptop confirms delivery; reply composer keeps text after success; (5) request-store: an accepted request over 1500 chars breaks the feed; diagnostics scrub misses quoted secrets with spaces. Each with a test that fails first.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
