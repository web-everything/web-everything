---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/static-selection-edges.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7212 (head 1f7c8f157)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7212 (reviewed head `1f7c8f157d09b6434a0dd2f58fa9e9d1ac1eb868`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/static-selection-edges.mjs:140` — (failing-input, degraded) Dot-slash filesystem paths silently lose shadow dependency edges
   - Scenario: Use source readFileSync('we:./scripts/lib/related-test-selection.mjs', 'utf8') in we:scripts/lib/__tests__/static-selection-edges.test.mjs, with both paths in files and the read target in changedFiles. shadowSelection returns tests:[] and partial:false. Removing only the leading './' selects the test. Filesystem paths resolve from the working directory, so these equivalent root-relative reads should produce the same dependency edge.
   - Class: live-reproduced (basis: Confirmed both path spellings read identical bytes from the repository, then invoked staticEdgesOf and shadowSelection with each spelling. Only the spelling without './' produced the dependency and selected test.)
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
