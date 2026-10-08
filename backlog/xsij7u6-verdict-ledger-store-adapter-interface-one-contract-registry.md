---
kind: story
size: 3
status: active
scaffoldedBy: "ledger-adapter"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/verdict-ledger-io.mjs", "we:scripts/lib/verdict-ledger-store.mjs", "we:scripts/lib/__tests__/verdict-ledger-store.test.mjs", "we:docs/agent/platform-decisions.md"]
dateOpened: "2026-10-08"
tags: []
---

# verdict ledger: store adapter interface (one contract, registry, home and git adapters, conformance suite)

Define one store contract for the verdict ledger (append, read returning rows or `unreadable`, a capabilities descriptor) and a name registry behind `verdictLedger.store`. Wrap the home-file and git-branch stores as adapters; add a conformance suite both pass. No behaviour change: existing tests stay green and the v1 fold is untouched. Operator direction 2026-10-07: delivery splits into protocol, core with pluggable stores, and Plateau as the product store.

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/verdict-ledger-store.test.mjs we:scripts/lib/__tests__/verdict-ledger.test.mjs we:scripts/lib/__tests__/verdict-ledger-io.test.mjs` passes; the store test fails before this item (no registry).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — rows are validated by the existing serializer before any store sees them.
2. **Truncated reads** — n/a: a partial line is skipped by the tolerant parser, as before.
3. **Shared state files** — home append keeps its existing lock; git keeps its push-retry.
4. **Fail closed** — a failed read is `unreadable`, never empty; a failed append is `ok:false`, never a throw.
5. **Identity scoping** — every call names its repo; rows of one repo per call.
6. **State over time** — n/a: append-only, no new state.
7. **Who wrote it** — n/a: the row's existing actor/source fields are unchanged.
