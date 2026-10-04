---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x25an7c-drain-merges-several-non-overlapping-ready-prs-per-pass-then.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a check:standards rule: a backlog card whose scope includes we:merge-ai-prs.mjs or the readin… (from web-everything/web-everything#3873 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/x25an7c-drain-merges-several-non-overlapping-ready-prs-per-pass-then.md:13` — Add a check:standards rule: a backlog card whose scope includes we:merge-ai-prs.mjs or the readiness gates must contain 'Must' lines covering refuse-on-error and non-source inputs. The same rule should reject a Done-when that still contains the literal 'TODO:' placeholder.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3873@8b60b6e9635704002c09013bb8ac8c430e7ed22e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
