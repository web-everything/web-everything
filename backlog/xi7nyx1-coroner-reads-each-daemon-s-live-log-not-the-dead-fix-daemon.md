---
kind: story
size: 1
priority: high
status: resolved
scope: ["we:scripts/operations/coroner-extract.mjs"]
dateOpened: "2026-10-09"
dateStarted: "2026-10-09"
dateResolved: "2026-10-09"
graduatedTo: none
tags: []
---

# Coroner reads each daemon's live log, not the dead fix-daemon log

we:scripts/operations/coroner-extract.mjs reads fix-dispatch-daemon.log from wev-review-daemon/.conveyor (last write 2026-10-07 13:22 ET); the live fix daemon logs to wev-fix-daemon/.conveyor/fix-dispatch-daemon.log (its launchd plist StandardOutPath). So refusalReasons/refusalByPr report stale PRs (#4017 x856, #3990 x336) and fix-side waits are missing from the JSON. Fix idea: resolve each daemon's log from its launchd plist StandardOutPath (or the daemon manifest), and print a stale-source warning when a source's last line is older than the window start. Evidence: coroner run 2026-10-09 (sources), ls -la of both .conveyor dirs. Found by coroner-4 (held item 189).

## Acceptance

- [A1] **Executable** — a test gives coroner-extract a fake plist whose StandardOutPath points at a fix-daemon log in another clone: before, it reads the hard-coded wev-review-daemon path; after, it reads the plist path.
- [A2] A source whose last line is older than the window start prints a `stale-source` warning naming the file and its last-write time (test).
- [A3] Live proof: a coroner run on this host reports current fix-side refusals (not #4017/#3990) and no stale-source warning for the fix daemon; before/after JSON in the PR.

## Non-goals

- [N1] Does not add per-card stage timestamps (held item 190).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the plist is parsed with a plist parser, not by string match; a path outside the home directory is refused.
2. **Truncated reads** — an unreadable or missing plist falls back to the current default path and adds a warning.
3. **Shared state files** — read-only; coroner never writes daemon logs or plists.
4. **Fail closed** — when no live source can be found, the report says so rather than reporting empty waits as zero.
5. **Identity scoping** — each daemon resolves from its own plist label; no cross-daemon fallback.
6. **State over time** — log rotation (`.log.1`) is read from the same resolved directory.
7. **Who wrote it** — n/a: logs are written only by our own daemons.
