---
kind: story
size: 2
status: open
scope: ["we:run.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# HIGH (2026-11-02 08:12 ET) File-scope collisions dominate worker time today

HIGH priority hint. - [ ] HIGH (2026-11-02 08:12 ET) File-scope collisions dominate worker time today: 6 of 8 dispatches this morning stopped on an occupied file held by our own open PRs (#6033 prepare/daemon-overlays, #6242 lane-pool, #6202/#6238 red-team-gate-apply, #6236 we:run.mjs, #6223 worker-brief). Two fixes: (a) land the long-open focus PRs that hold hub files (prioritise #6202/#6238/#6242/#6236 merges); (b) free-scope should report hunk-level overlap, so disjoint edits in the same file proceed with a merge-tree check instead of a stop.

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
