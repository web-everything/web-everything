---
bornAs: x6uq55r
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5282 (head de28e7794)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5282 (reviewed head `de28e7794f84eed3ed23ae230b7c9cbd146e9ecc`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:577` — (edge-case, degraded) Parallel catch-up starts additional drains after enqueue-on-event is disabled
   - Scenario: Configure concurrency=3, capacity=3, an empty queue, and three ready PRs. Start catchUp(), leave the first child unfinished, and change the resolved setting to enabled=false immediately after that child starts. The injected probe observed --only=2 and --only=3 starting with enabled=false. Because ran.length remains zero until a child finishes, the scheduler skips refreshing the setting while launching siblings. Previously, serial execution awaited the first child and then honored the disable before starting another. Refresh and honor enablement before each additional start; existing children m
   - Claude's re-check: The setting refresh is guarded by 'if (ran.length)', and 'ran.push' happens only when a child finishes. With concurrency&gt;1, catch-up children aren't awaited, so while the first child runs 'ran.length' stays 0. The loop then starts siblings 2 and 3 using the stale 's' and never calls 'readSetting'/'honourSetting'. The old serial path awaited each child, so it honored a disable before the next start.

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
