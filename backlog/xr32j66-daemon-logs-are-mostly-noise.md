---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Daemon logs are mostly noise

[held entry 323] (daemon-async-audit 2026-10-14, held) Daemon logs are mostly noise. lane-pool-health-watch-we writes ~70 MB/day: the full ~140 KB {"checked":…,"plan":[…]} JSON every pass plus 61 "already clean" lines, so 20 MB×2 rotation keeps only ~14 h. GH_DEBUG HTTP dumps (label mutations) leak into review-daemon and fix-dispatch logs. daemon-self-sync-state/206df80….alerts.jsonl holds 12 MB of repeated untracked-kept lists. Fix idea: print the JSON only with --json or when the plan changed (we:lane-pool-health-watch.mjs:813,841); strip GH_DEBUG from child env; dedupe repeated alerts. Design: lazy (print on change). Size 1.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
