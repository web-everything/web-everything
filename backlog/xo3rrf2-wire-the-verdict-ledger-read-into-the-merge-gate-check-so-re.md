---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-gate-check.mjs", "we:scripts/lib/merge-gate-ci.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Wire the verdict-ledger read into the merge-gate check so reviewAuthority ledger and both can pass

PR 4708 review: we:scripts/merge-gate-check.mjs now reads mergeGate.reviewAuthority and fails the ledger gate closed for ledger and both, because it gathers no ledger evidence (folded and derived stay null). Read the shared ops/review-requests ledger in the gatherer (fold plus derive, unreadable stays a hold) so a configured ledger or both authority can actually clear in CI. Test with an injected exec in we:scripts/lib/__tests__/merge-gate-ci.test.mjs.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/merge-gate-ci.test.mjs` includes tests where `gatherPrFacts` (injected exec) returns ledger evidence and `ledger`/`both` authority then pass for a clearing ledger and hold for a non-clearing one; it fails before this item and passes after.

## Non-goals

- [N1] Does not change the settings source of `mergeGate.reviewAuthority` and does not make the drain consult the ledger.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — ledger entries are parsed as data; a malformed entry is unreadable, not empty.
2. **Truncated reads** — a truncated ledger read is `unreadable` and defers (fail closed).
3. **Shared state files** — the ledger branch is read-only here; a concurrent writer only changes the head it is judged against.
4. **Fail closed** — an unreadable ledger or settings error holds, as `decideLedgerGate` already does.
5. **Identity scoping** — the ledger entry must cover this PR number and head sha.
6. **State over time** — a clearance covering an older head does not clear.
7. **Who wrote it** — n/a: the verdict author is the ledger's concern, not this gatherer's.
