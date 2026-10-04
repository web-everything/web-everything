---
bornAs: xhv10yu
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# A PR that fixes red main is exempt from the main-red hold

Live deadlock 2026-10-03: PR #3828 restores the soak fixture that broke main CI, but its first CI run failed (a GitHub API rate limit on soak-replay-gate, and a test shard with no output). The fix daemon then held it as owed-ci-rerun: 'owed a mechanical rebase onto main once main recovers'. Main could only recover through #3828; it needed a labelled emergency re-run by hand. Fix: we:scripts/conveyor/reconcile-core.mjs and we:scripts/conveyor/reconcile-fix-dispatch.mjs recognise a main-fix PR and exempt it from main-still-red and owed-ci-rerun holds, re-running its failed checks at once. A PR is a main-fix PR if it carries a main-fix label (set by whoever opens it), or its diff touches a file in main's latest failing test output. The drain also lands a green main-fix PR first. Done when: tests cover both detection paths and the exemption; a soak break replays the #3828 deadlock.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
