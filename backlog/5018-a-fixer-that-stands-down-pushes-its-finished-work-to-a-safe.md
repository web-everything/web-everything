---
bornAs: x65zrc1
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:skills-src/conveyor/fix-agent-brief.md"]
dateOpened: "2026-10-03"
tags: []
---

# A fixer that stands down pushes its finished work to a safe ref and releases its fix claim

Live 2026-10-03 on PR #3787: the fix-3787 session resolved the merge conflict (commits 208b096c2, 39ce52034 in lane-3), then stood down with gate-red on one 5s timeout in an untouched test (duplicate-live-sessions) under laptop load ~40-63, and its session ended. Result: the finished work sat unpushed in an unleased lane (at risk of recycling), and its fix claim stayed held, so we:scripts/conveyor/reconcile-fix-dispatch.mjs refused every new dispatch with fix-claimed. The operator's stand-down answer reached no one; recovery needed a labelled emergency push by hand. Fix: on any stand-down, the fix procedure (we:scripts/conveyor/fix-procedure.mjs, we:scripts/conveyor/stand-down.mjs) pushes the lane HEAD to a durable ref (e.g. refs/heads/wip/fix-<pr>-<sha>) and records it on the PR, then releases the fix claim via fix-end. A later stand-down answer dispatches a fresh fixer that resumes from that ref instead of redoing the work. Done when: tests cover push-on-stand-down, claim release, and resume-from-ref; a soak break replays the #3787 case (fails on old code, passes on new).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
