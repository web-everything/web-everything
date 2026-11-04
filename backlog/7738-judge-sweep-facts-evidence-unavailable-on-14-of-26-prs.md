---
bornAs: xajg4va
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# judge-sweep-facts: evidence-unavailable on 14 of 26 PRs

MED priority hint. ## (held 2026-10-25 18:28 ET) judge-sweep-facts: evidence-unavailable on 14 of 26 PRs The 18:26 sweep bundle (run from a fresh lane at origin/main) could not read verdict details for #5759 #5878 #5910 #5919 #5922 #5923 #5927 #5929 #5931–#5943 ("verdict details unavailable", ledger-only), so it could not confirm owed approvals or red-team state. Trace the read failure; it overlaps with the R107 stuck-PR trace (same data).

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
