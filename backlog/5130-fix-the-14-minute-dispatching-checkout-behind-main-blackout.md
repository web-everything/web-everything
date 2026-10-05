---
bornAs: x6in7gk
kind: story
size: 3
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Fix the 14-minute dispatching-checkout-behind-main blackout

On 2026-10-04 from 20:07 to 20:21 ET every web-everything fix-dispatch tick refused (dispatching checkout is N commits behind main) until self-sync rebuilt. With #3929 the guard should give grace while a rebuild is due or in progress. Find out why it did not, and shorten the self-sync lag.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
