---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/pr-status.mjs", "we:scripts/operations/__tests__/pr-status.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# A required check that can never run on a PR is reported once, not re-read as unchecked every tick

Follow-up from the #3432 advisory (2026-10-02). we:scripts/operations/pr-status.mjs:179: the new missing-required rule makes any PR on which a required check can never run (for example a workflow filtered to main-based PRs) permanently unchecked, and every tick pays a paginated REST read plus a check-read-failed refusal. Detect required checks whose workflow cannot run for the PR base and report that once as a configuration problem; add a standards check comparing the branch-protection required set with each workflow pull_request branches filter.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
