---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/audit-nonconvergence.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7541 (head 09d9b3638)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7541 (reviewed head `09d9b3638626f956635d87813ab8ab1fa0d2dbd4`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/audit-nonconvergence.mjs:39` — (failing-input, degraded) Valid repository names beginning with punctuation are rejected
   - Scenario: Take we:two-new-classes.json, change repo in the root and both rounds to example/.github, and refresh the provenance hashes. runCli returns exit 2 with INVALID_MANIFEST instead of the expected RECOMMEND_DESIGN at sequence 2. The repository-name regex requires an initial alphanumeric character, excluding valid GitHub repository names such as .github and _repo. Accept these canonical lowercase owner/name identities.
   - Class: live-reproduced (basis: Reproduced through runCli with the bounded-reader adapter and refreshed provenance hashes; the otherwise equivalent original fixture recommends design review.)
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
