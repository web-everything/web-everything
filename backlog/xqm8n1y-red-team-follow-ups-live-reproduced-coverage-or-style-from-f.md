---
kind: story
size: 2
status: open
scope: ["we:tests/a11y/sitemap-routes.ts"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from frontier-ui/frontierui#59 (head a7639015d)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#59 (reviewed head `a7639015d5695778e798dbe0917eeb8ab29bed41`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:tests/a11y/sitemap-routes.ts:102` — (edge-case, degraded) Unescaped filenames can make the gate scan a different demo
   - Scenario: With clean we:demos/clean.html and an inaccessible we:demos/clean.html#we:broken.html, discovery returns both raw paths. Navigation to the second path requests we:clean.html because #we:broken.html is a fragment. Even A11Y_ENFORCE=1 therefore scans the clean page twice and misses the inaccessible page. Filename segments should be URL-encoded so each discovered file is actually scanned. A question mark in a filename causes the same problem.
   - Class: live-reproduced (basis: A read-only Node probe executed the actual demoPages function with synthetic directory entries. It returned we:/demos/clean.html#we:broken.html and we:/demos/clean.html?we:broken.html; URL resolution mapped both to pathname we:/demos/clean.html. Browser and axe execution were unavailable because dependencies are not installed.)
   - Also class: coverage-or-style
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
