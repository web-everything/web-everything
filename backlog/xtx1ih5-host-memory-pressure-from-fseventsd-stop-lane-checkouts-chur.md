---
bornAs: xtx1ih5
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/conveyor/tick-core.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Host memory pressure from fseventsd: stop lane checkouts churning FSEvents/Spotlight

2026-10-28. Memory hold is real: pressure level 2, swap 3.9G/5G, ~23G compressed; root fseventsd at 9.8G RSS from ~100 lane checkouts churning. Fix: .metadata_never_index in lane roots, VS Code files.watcherExclude for .lanes, fewer idle lane checkouts; host health-watch alert on fseventsd RSS. Related: #4793.

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
