---
bornAs: xnpjfoq
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-smells/", "we:scripts/conveyor/health-watch.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Health daemon sweeps stale Claude config temp files

Held item 204 (session 2026-10-10; operator OK). Live: 7,123 temp copies of the Claude user config file in the home dir (name pattern: the config file name followed by `tmp.<suffix>`; 3.5 GB, back to Sep 1) plus 369 empty `lock.stolen.<suffix>` dirs next to it, left by sessions/workers killed mid-write of the 3 MB config; cleaned by hand once 2026-10-10 13:20 ET (emergency, operator Go). Fix: a health-watch sweep deletes those temp copies and the empty lock.stolen dirs older than N min (setting `health.claudeTempSweepMinAgeMin`, default 60, via the cascade; also under $CLAUDE_CONFIG_DIR when set), and logs counts and bytes.

## Acceptance

- [A1] **Executable** — a test with fresh and old temp files and lock.stolen dirs deletes only the old ones and only empty dirs; the live config file is never touched.
- [A2] **Live** — one sweep log line with counts and bytes, and the temp-file count stays near zero over a day.

## Non-goals

- [N1] Touching the live config file or non-empty lock dirs.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: file names only, matched by a fixed pattern.
2. **Truncated reads** — A stat error on one entry skips it, the sweep continues.
3. **Shared state files** — Files under the home config dir; only exact-pattern matches older than the age are removed.
4. **Fail closed** — Anything not matching the exact pattern, or younger than the minimum age, is kept.
5. **Identity scoping** — Scoped to the home dir and $CLAUDE_CONFIG_DIR only.
6. **State over time** — Age threshold protects in-flight writes.
7. **Who wrote it** — n/a: the files are left by Claude processes; the sweep only removes stale ones.
