---
bornAs: xdt06rk
kind: story
size: 3
priority: high
parent: "5445"
status: open
scope: ["we:conformance-vectors/verdict-ledger-store.vectors.json", "we:conformance-vectors/verdict-ledger-store.vectors.ts", "we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs", "we:scripts/lib/__tests__/verdict-ledger-store.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger standard: store contract as language-neutral conformance vectors

Slice of #5445 (A4, store half of A1). Publish the verdict-ledger store contract that #5462 already implemented in we:scripts/lib/verdict-ledger-store.mjs (async append/read, idempotent append by event id, unreadable never empty, invalid row refuses the batch, append order, singleWriter and shared declared) as language-neutral conformance vectors in we:conformance-vectors/, and drive the existing JS suite we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs from them. Done when the vectors run against the home and git adapters and a deliberately broken adapter (non-idempotent append, empty-on-failure read) fails. No adapter code changes.

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
