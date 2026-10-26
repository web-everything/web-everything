---
bornAs: x1n4sy0
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# plateau wip-publisher ran ~84% CPU continuously for 16.5h

[held entry 325] (2026-10-14, held) plateau wip-publisher ran ~84% CPU continuously for 16.5h (launchd com.plateau.wip-publisher, KeepAlive, npm run wip:publish → vite-node we:scripts/wip-publish.ts) contributing to load 12–17 that starved daemon self-update smokes; operator had it unloaded. Find the busy loop (polling without sleep / watcher on huge tree), add backoff + CPU budget; decide if it should run as a launchd KeepAlive service at all. Operator 2026-10-14 ~11:05 ET: it probably syncs the plateau progress (WIP/live state); fine to keep stopped for now; fix so it publishes on change with backoff instead of burning CPU, then re-enable.

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
