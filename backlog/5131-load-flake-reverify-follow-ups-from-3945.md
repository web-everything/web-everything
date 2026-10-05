---
bornAs: x6rj2sa
kind: story
size: 3
status: resolved
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
dateResolved: "2026-10-05"
tags: []
---

# Load-flake-reverify follow-ups from #3945

Priority on (b). (a) Revalidate the EXACT hold verified (same alt branch and sha) before pushing, not just that a hold is live. (b) scrubVerifyEnv is a denylist that misses API_KEY, SSH_AUTH_SOCK, *_ACCESS_KEY_ID and keeps HOME; switch to an allowlist so fixer-authored test code never sees secrets. (c) live load-flake holds are no longer counted by countStandDownComments, so isNeverStuckPr in stuck-pr-watch misses them; restore that.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
