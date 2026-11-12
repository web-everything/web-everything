---
kind: story
size: 3
status: active
scaffoldedBy: "file-held-cards-nov12"
dateScaffolded: "2026-11-12"
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-12"
tags: []
related: ["4014"]
---

# Lane trim keeps a free reserve of acquirable lanes and recycles stale pinned lanes

2026-11-12 01:46 ET: trim removed all 21 idle lanes; acquire re-provisioned 15 within 45 min (disk churn). Trim must keep a free reserve. Pinned lanes (41) with stale unpushed/uncommitted work >24h should be bundled and recycled like #6693 does for stashes.

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

## Duplicate admission

extends the cap/prune work with a reserve and pinned-lane recycling
