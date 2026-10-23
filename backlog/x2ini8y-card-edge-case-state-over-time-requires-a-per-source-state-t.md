---
kind: story
size: 5
status: open
scaffoldedBy: "fix-5608"
dateScaffolded: "2026-10-21"
scope: ["we:scripts/backlog/edge-case-classes.mjs", "we:scripts/backlog/__tests__/edge-case-classes.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Card edge-case State over time requires a per-source-state table when a change retires or discards stateful records

Prevention owed by PR 5608 review (finding on x5nmdnt: a closed-unmerged collector batch would retire and silently drop its members, because the card's State over time line named only merged). When a card retires, discards or resets a stateful record, its State over time edge case must list every source state that triggers it (for a PR: merged, closed-unmerged, unreadable), what happens to the record and to its dependents in each, and one named test case per row. A card whose line names a retirement but only one source state is refused by the edge-case lint with the missing rows named.

PR 5608's round-4 review owed more guards of the same kind (a card promises a guarantee that no planned case pins). The lint enforces them together, on cards with `status: open` that carry a Planned cases block:

1. **Non-terminal row.** The per-source-state table must include the non-terminal state (for a PR: open) with a case showing it is left alone.
2. **Ordering and recovery claims.** A Shared state files or State over time line that claims an ordering or a crash recovery ("before", "crash", "resumes", "retried") must name an [A1] case, and that case must be a fault-injection case.
3. **Archive consumers.** A card that adds a new way for a state to leave the active slot must name each consumer of that archive (for the collector: the seal scan) with a case showing the consumer does not undo the hold.
4. **No TODO lines.** A TODO left in Acceptance or in any edge-case line is refused.
5. **Scope to tests.** Every non-test file in scope has a planned case in a test file for that module, or an `n/a:` line.
6. **Default flips.** A card that flips a shipped default lists each sibling card's planned case that asserts that default, and says how it replaces it.
7. **Statute rules.** A codified decision entry added or changed in the diff has each numbered rule cite a planned or existing case by name, or be marked unpinned. Entries the diff does not touch are listed as warnings, never refused.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/backlog/__tests__/edge-case-classes.test.mjs` fails before this item lands and passes after. Planned cases:
  - `retirement line naming only one source state is refused with the missing rows named` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs) — a State over time line that retires on merged alone is refused, naming closed-unmerged and unreadable.
  - `retirement table with every source state and a case per row passes` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `retirement table without the open row is refused` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `ordering claim without a named fault-injection case is refused` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `new archive path without a case per consumer is refused` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `open card with a TODO acceptance or edge-case line is refused` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `scope file with no planned case or n/a is refused` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `default flip without the replaced sibling cases is refused` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `statute rule with no cited case and no unpinned mark is refused` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs) — for an entry the diff adds or changes.
  - `untouched statute entry without cited cases only warns` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs).
  - `refusal names only the failing card and entry` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs) — with two open cards and two changed decision entries, one of each failing, the refusal names only the failing card and the failing entry anchor; the passing card and entry are not listed.
  - `resolved or Planned-cases-free card only warns` (we:scripts/backlog/__tests__/edge-case-classes.test.mjs) — a resolved card and an open card without a Planned cases block, each with a TODO acceptance line, are listed as warnings and not refused.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] The lint reads card text and, for rule 7 only, the decision entries the diff touches. It does not check that a named case exists in a test file; the slice's own verify does that.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card markdown is parsed section by section; a section the lint cannot parse is refused by name, never skipped.
2. **Truncated reads** — n/a: whole committed files are read; a read error fails the lint.
3. **Shared state files** — n/a: the lint is read-only.
4. **Fail closed** — a card the lint cannot classify is refused, not passed.
5. **Identity scoping** — rules apply per card; rule 7 applies per decision entry anchor (case `refusal names only the failing card and entry`).
6. **State over time** — the rules refuse only open cards with a Planned cases block, and only decision entries the diff adds or changes; older and resolved cards and untouched entries are listed as warnings, not refused (cases `resolved or Planned-cases-free card only warns`, `untouched statute entry without cited cases only warns`).
7. **Who wrote it** — n/a: the rules apply equally to any author.
