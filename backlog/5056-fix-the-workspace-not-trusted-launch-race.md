---
bornAs: x0p1395
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/bootstrap-session.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Fix the Workspace not trusted launch race

Live 2026-10-03/04: fixer launches (claude --bg ...) intermittently failed with 'Workspace not trusted' for #3794, #3881, #3889 and plateau #202. The dispatch was refused and the PR waited a pass or more. #3896 now logs the real stderr. Find why the trust check races (a trust file written after the launch, or a new lane not yet trusted); see the TRUST_REFUSAL_PATTERN handling in we:scripts/operations/dispatch-lane-io.mjs and bootstrap trust in we:scripts/bootstrap-session.mjs. Done when: (1) root cause is named with evidence from the #3896 stderr logs; (2) a lane is trusted before any launch; (3) the launch retries once immediately on that specific error; (4) a test reproduces the race and passes after the fix; (5) no new 'Workspace not trusted' refusals in the next live passes.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
