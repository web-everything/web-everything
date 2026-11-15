---
bornAs: xmvz4up
kind: story
size: 3
status: open
scope: ["we:scripts/operations/record-red-team-ruling-cli.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Card rulings need a merged NNN: accept an open card PR bornAs id, and fix the ruling CLI usage line

record-red-team-ruling and record-referral-ruling require a MERGED card NNN, so every fix-now card ruling waits a full card-PR land (about 1h; #6844, #6732 on 11-14). Accept a bornAs xHASH id from an open card PR (resolve to NNN on land), or let the op land the card itself. Also the record-red-team-ruling usage line says we:run.mjs record-red-team-ruling but we:run.mjs does not register it (must use we:record-red-team-ruling-cli.mjs).

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
