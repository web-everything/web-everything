---
kind: story
size: 5
parent: "xpd5nhi"
status: open
blockedBy: ["x3xrhfl"]
scope: ["we:skills-src/conveyor/**", "we:scripts/daemons/**"]
dateOpened: "2026-10-08"
tags: []
---

# Move daemon entry points out of skills-src/conveyor into scripts/daemons, with forwarding shims

Daemon code lives inside skill folders (33 imports from core into skills-src). Move build-dispatch, verify, review, reconcile-fix-dispatch and pass daemons, the supervisor and briefs to scripts/daemons/, leaving one-line forwarding files at the old paths so the launchd plists keep working unchanged.

## Acceptance

- [A1] **Executable** — each moved daemon runs one pass from its new `scripts/daemons/` path, and from the old `skills-src/conveyor/` path through the shim, with the same journal entries (before/after evidence in the PR).
- [A2] No launchd plist changes; every `com.we.*` job keeps its current program path.
- [A3] The core to skills-src import count drops to zero apart from the shims.

## Non-goals

- [N1] Moving skill prompts or skill definition files; only daemon code moves.
