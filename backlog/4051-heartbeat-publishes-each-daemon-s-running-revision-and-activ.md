---
bornAs: x0m1pkt
kind: story
size: 3
parent: "3383"
status: open
blockedBy: ["4050"]
scope: ["we:scripts/operations/runner-activity.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Heartbeat publishes each daemon's running revision and active overlays

Ruling #3681, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 6. Record the boot input heads (per repo: origin/main sha and each overlay head) in the daemon's heartbeat or lease record, and have we:scripts/operations/runner-activity.mjs report them for every daemon listed in DAEMON_MANIFEST (we:skills-src/conveyor/daemon-manifest.mjs), so an operator can read 'running abc plus overlay X, clone at def'. bootSha appears nowhere today. #3756 reads the same record.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

## Additions from 2026-09-24 incident review

- **Report "commits behind", not just the sha.** Add `behindMain` (commit count from the boot origin/main sha to the current origin/main) and `lastRejectedSha` (the sha the #4038 smoke gate refused, with its reason). Live case: a daemon ran 9 commits behind main after a smoke rejection and nobody could see it. #4045's behind-main alert reads these two fields.
- **Cover every daemon, not three.** `KNOWN_DAEMONS` in we:scripts/operations/runner-activity-io.mjs lists only the dispatcher, fix-dispatch and review daemons. The verify daemon (we:skills-src/conveyor/verify-daemon.mjs) and each pass-daemon watcher from `DAEMON_MANIFEST` are missing, and the drain is read separately by plateau. The heartbeat and runner-activity should list all of them, so the /wip daemon chips show the whole fleet.
- **Done-when proposal:** a runner-activity fixture with a daemon booted at sha A while origin/main is at A+9 reports `behindMain: 9`; a fixture with a rejected smoke record reports `lastRejectedSha` and its reason; the verify daemon and at least one pass-daemon watcher appear in `runners[]`.
