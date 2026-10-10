---
bornAs: x34aj42
kind: story
size: 3
priority: high
parent: "3007"
status: resolved
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/pr-merge-gate.mjs", "we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-10"
tags: []
---

# Drain ledger shadow: the drain runs the pure ledger gate beside the labels and journals every disagreement

Ledger product review, operator 2026-10-08, D4 (slice I2 of the verdict-ledger plan, unpaused). The drain (we:scripts/merge-ai-prs.mjs) calls the pure decideLedgerGate in we:scripts/lib/pr-merge-gate.mjs for every PR it would land and journals each case where the ledger verdict and the labels disagree. Merge behaviour does not change. The setting mergeGate.reviewAuthority in we:config/platformDefaults.ts moves to both only after three conditions hold: readers use the shared store, the checker (we:scripts/review-ledger-check.mjs) shows 7 clean days per label family, and the store contract is async. Slice L (ledger alone decides) stays an operator-ratified statute PR.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs` covers a drain pass where labels and the ledger disagree, and the case is journaled; the test fails before this item.
- [A2] The drain calls decideLedgerGate for every PR it evaluates and journals each disagreement (PR, head, label verdict, ledger verdict, reason) without changing what it lands.
- [A3] The flip of mergeGate.reviewAuthority to `both` is a separate, later change and happens only when all three hold: readers use the shared store, the checker shows 7 clean days per label family on that store, and the store contract is async.
- [A4] A ledger read that is unreadable is journaled as unreadable, never as agreement.

## Non-goals

- [N1] Does not move the setting to `both` in this item.
- [N2] Slice L (ledger alone decides) stays an operator-ratified statute PR.
- [N3] Making readers use the shared store and the async contract are filed separately by another agent (lane purpose ledger-shared-readers); this card must add that card to blockedBy once it exists.

## Edge cases this change must handle

1. **Untrusted text** — PR bodies and comments are data; nothing in them is executed or trusted as a verdict.
2. **Truncated reads** — a cut-off or failed read is unreadable, never empty.
3. **Shared state files** — writes go through the store contract's single-writer guarantee.
4. **Fail closed** — on unreadable state the gate holds, it does not merge.
5. **Identity scoping** — events are per repo and per PR head.
6. **State over time** — append-only; old rows are never rewritten.
7. **Who wrote it** — every event records its writer.

## Outcome

- The shadow lives in we:scripts/lib/drain-ledger-shadow.mjs. The drain (we:scripts/merge-ai-prs.mjs) calls it once per pass, after every merge decision is final, with three added lines. It compares each considered PR's label answer with `decideLedgerGate` in `ledger` mode and writes one `drain-ledger-shadow` run record per pass. Each row holds the PR, head, label verdict, ledger verdict, status, direction and reason. Verdicts are never changed and `mergeGate.reviewAuthority` stays `labels`.
- An unreadable or late (20 s) ledger read is recorded as `unreadable`, never as agreement (A4). A PR with no ledger row is a ledger hold.
- `review-ledger-check --history` (we:scripts/review-ledger-check.mjs, we:scripts/lib/review-ledger-history.mjs) now also prints per-day shadow counts: passes, compared, disagreements per direction, unreadable.
- The flip to `both` (A3) is still a separate operator change. It is gated on #5462 (readers on the shared store), 7 clean days, and the async store contract.
