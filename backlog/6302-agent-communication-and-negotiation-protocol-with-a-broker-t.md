---
bornAs: xzx3zvm
kind: epic
status: parked
blockedBy: ["3007"]
dateOpened: "2026-10-18"
tags: []
---

# Agent communication and negotiation protocol, with a broker that enforces the rules

Operator 2026-10-17/18: "Eventually, we will want a protocol for communication and negotiation between agents" + "probably a broker or mediator to help rules being respected".

Today agents negotiate through ad-hoc channels: labels and PR comments (send-backs, binding fixer input, "fixer and reviewer disagree"), the free-scope registry ("waiting 5th behind"), and ruling ladders (resend > stronger-model > cross-provider). Most stalls on 2026-10-17 happened at these seams:
- #5461/#5482/#5486: red-team result saved but the comment was lost;
- #5514/#5549: an auto-policy block misread as an operator ruling, looping a stronger model;
- #5551: binding input with no channel on a review:changes PR;
- #5599: 5th in a scope queue behind rival PRs on one file;
- #5514: a recorded ruling the pause didn't see.

Shape: typed messages (claim, request-stack, yield, dispute, ruling, handoff), carried by the verdict ledger (not comment text). A broker/mediator validates each message against the ratified rules (stringency table, stacking policy, settings guard floor, operator authority), rejects or routes violations, and resolves disputes through a declared path that ends at the operator. Standards-shaped (a WE delivery protocol) and tracked in the delivery-protocols metrics. Prepare after the ledger is authoritative (epic 3007 / cards x9qibqz, x2sgweq).

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
