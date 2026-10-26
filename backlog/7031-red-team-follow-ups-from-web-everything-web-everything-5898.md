---
bornAs: x4m9phc
kind: story
size: 2
status: open
scope: ["we:scripts/operations/card-batch-extract.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5898 (head c39b5162b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5898 (reviewed head `c39b5162b54eb0e9a49a8efeffc4946aabd2c030`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/card-batch-extract.mjs:207` — (edge-case, degraded) A completed split cannot finalize after its closed source branch is deleted
   - Scenario: Complete extraction through persisting journal.closed=true, then crash before journal.done is saved. Delete the now-closed original batch branch and retry. The new unconditional source-head check returns head-mismatch, leaving the journal unfinished and the old manifest without extractedTo, although all remote work already succeeded. An in-memory probe of extractCard reproduced this: with identical completed journals, an absent source ref returned refuse and left bookkeeping unfinished; retaining the ref returned extracted and finalized both records. Recovery should finish local bookkeeping fo
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
