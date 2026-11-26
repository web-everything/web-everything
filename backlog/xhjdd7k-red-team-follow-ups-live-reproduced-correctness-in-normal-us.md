---
kind: story
size: 2
status: open
scope: ["we:src/assets/js/backlog-table-sort.js"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7525 (head 41de9ffb9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7525 (reviewed head `41de9ffb9d87594c2aec3169c831238ad5603a67`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:src/assets/js/backlog-table-sort.js:6` — (edge-case, degraded) Hot reload leaves the prioritisation table permanently limited to its preview
   - Scenario: Load all rows on /backlog/, then edit we:src/backlog.njk so Eleventy's DOM update restores the server-rendered preview while retaining the table element. Click Show all again. The retained withPrioRows function causes initialization to return early, leaving prioLoaded true, so no fragments are fetched and rows beyond the first 250 remain missing. The loader should detect the replaced preview and reload the fragments.
   - Class: live-reproduced (basis: Executed the checked-out script in Happy DOM with the installed morphdom implementation. A three-row fixture loaded with two requests; morphdom retained the table and restored its one-row preview. Reinitialization followed by Show all left one row and made no additional requests. Eleventy's installed reload client uses this DOM update mechanism.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
