---
bornAs: xizlly0
kind: story
size: 3
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/operations/prototype-load.mjs", "we:scripts/lib/daemon-rebuild/auto-rebase.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# One path rebuilds a daemon top: worker top-refresh and bundle-repair check each other's hold

Held card 2026-11-01 15:16 ET. An orchestrator top-refresh worker (health-watch 1101c) raced the daemon's automatic bundle-repair (1101d); repair stood down and escalated. Fix: the worker brief and the loader check for an active bundle-repair hold on that daemon before building a top, and bundle-repair checks for an in-flight loader lane, so only one path rebuilds a top.

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
