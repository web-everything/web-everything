---
bornAs: x24kt1c
kind: story
size: 2
status: open
related: ["2885"]
scope: ["we:scripts/prune-landed-lanes.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# prune-landed-lanes lists open PRs with --limit 200 (initial and pre-delete recheck) and treats the list as co…

Flow-sim gap R8a-G4, class K17 (partial page read as complete). Failing input: More than 200 open PRs. lane/foo backs an open PR beyond the first 200 rows and its content is already byte-equal to main after a three-way merge (e.g. a PR whose change main later absorbed by another route). 'node we:scripts/prune-landed-lanes.mjs --yes Cited: we:scripts/prune-landed-lanes.mjs:165, we:scripts/prune-landed-lanes.mjs:174-175, we:scripts/prune-landed-lanes.mjs:199-203, we:scripts/prune-landed-lanes.mjs:215-225, we:scripts/prune-landed-lanes.mjs:244. Soak-break sketch: Fixture: injectable listOpenPrs returning exactly 200 rows (length == limit) that omit the branch being deleted. Action: sweep --yes through the CLI seam / a new pure `listIsComplete(rows, limit)` guard. Assert (fails today): when rows.length >= limit the swe…

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
