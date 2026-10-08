---
kind: decision
size: 2
parent: "xliqbhq"
status: open
dateOpened: "2026-10-08"
tags: []
---

# Delivery protocol home: separate repo now, or incubate inside Web Everything

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Open decisions' item 1 and 'Proposed structure'. Fork: (a) a new repo now that holds only the standard (schemas, role registry, policy dimensions, glossary, conformance cases), with the engine staying where it runs until extraction; (b) incubate the standard inside Web Everything first. Incubating is faster, but WE's own history shows implementation leaking into a standard repo becomes relocation debt, and the scope is not web (#1282 zero-implementation rule). Brief's recommendation: (a). Operator's call; not ruled here.

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; if (a), a follow-up card creates the repo.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
