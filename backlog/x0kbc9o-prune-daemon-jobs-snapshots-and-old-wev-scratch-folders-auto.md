---
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/operations/run.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Prune daemon-jobs snapshots and old wev-scratch folders automatically

Disk hit 97% (R433). Daemons leave 2 code and node-modules snapshots each under ~/.claude/daemon-jobs (about 20G) plus stale job-*.result probe files (about 2.5G in health-watch), and 56 wev-scratch-* folders (18G) piled up under ~/workspace. Add a scheduled pass that keeps the newest N snapshots per daemon (never one a plist or live process cwd uses), drops old job results, and archives then deletes idle scratch folders. Reuse we:scripts/lane-pool.mjs gc style safety checks (lsof cwd, lane and daemon-clone registry).

## Acceptance

- [A1] **Executable** — Executable: a dry-run of the prune pass lists candidates and exits 0; a test shows an in-use snapshot is never listed.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not touch .lanes, daemon clones or dev servers.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Handled: pass only acts on paths from its own directory listing, never on text read from files.
2. **Truncated reads** — n/a: no external text is parsed.
3. **Shared state files** — Handled: pass only acts on paths from its own directory listing, never on text read from files.
4. **Fail closed** — Handled: pass only acts on paths from its own directory listing, never on text read from files.
5. **Identity scoping** — Fail closed: any failed in-use check skips the path.
6. **State over time** — Handled: pass only acts on paths from its own directory listing, never on text read from files.
7. **Who wrote it** — Handled: pass only acts on paths from its own directory listing, never on text read from files.
