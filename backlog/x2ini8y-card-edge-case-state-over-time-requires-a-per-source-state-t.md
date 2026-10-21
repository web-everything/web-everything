---
kind: story
size: 3
status: open
scaffoldedBy: "fix-5608"
dateScaffolded: "2026-10-21"
scope: ["we:scripts/backlog/edge-case-classes.mjs", "we:scripts/backlog/__tests__/edge-case-classes.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Card edge-case State over time requires a per-source-state table when a change retires or discards stateful records

Prevention owed by PR 5608 review (finding on x5nmdnt: a closed-unmerged collector batch would retire and silently drop its members, because the card's State over time line named only merged). When a card retires, discards or resets a stateful record, its State over time edge case must list every source state that triggers it (for a PR: merged, closed-unmerged, unreadable), what happens to the record and to its dependents in each, and one named test case per row. A card whose line names a retirement but only one source state is refused by the edge-case lint with the missing rows named.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/backlog/__tests__/edge-case-classes.test.mjs` fails before this item lands and passes after. Planned cases:
  - `retirement line naming only one source state is refused with the missing rows named` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs) — a State over time line that retires on merged alone is refused, naming closed-unmerged and unreadable.
  - `retirement table with every source state and a case per row passes` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).

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
