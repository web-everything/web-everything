---
kind: story
size: 2
status: open
scope: ["we:docs/agent/platform-decisions.md"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7310 (head 8da3baf26)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7310 (reviewed head `8da3baf26b05c05539d4e98f01973854e24c913b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:docs/agent/platform-decisions.md:6218` — (edge-case, degraded) Lost-response retries conflict with the mandatory sequence-mismatch rule.
   - Scenario: Start with prSeq=0. appendIf([event E], {repo, pr, expectPrSeq:0}) commits E, but its response is lost. Retry the identical request. The stored prSeq is now 1, so the unconditional mismatch rule requires returning conflict:true. Yet E must count as a duplicate as in append, which returns successful duplicate-only results. The retry therefore cannot satisfy both clauses. Explicitly define duplicate-only retry precedence over the sequence check, while retaining the check for requests that would append new rows.
   - Class: correctness-in-normal-use (basis: This is a sequential lost-response recovery case explicitly promised by the new contract, requiring no concurrent writers. The existing append contract defines duplicate-only requests as successful. The failure is contradictory specification requirements; no appendIf runtime implementation is introduced in this PR.)
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
