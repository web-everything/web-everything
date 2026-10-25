---
bornAs: xdt06rk
kind: story
size: 5
priority: high
parent: "5445"
status: open
scope: ["we:conformance-vectors/verdict-ledger-store.vectors.json", "we:conformance-vectors/verdict-ledger-store.vectors.ts", "we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs", "we:scripts/lib/__tests__/verdict-ledger-store.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger standard: store contract as language-neutral conformance vectors

Publish the implemented store contract as language-neutral JSON operation/result vectors in we:conformance-vectors/verdict-ledger-store.vectors.json (proposed), with its proposed TypeScript wrapper we:conformance-vectors/verdict-ledger-store.vectors.ts. Drive the existing JS conformance runner from that data. Preserve current partial-write semantics: invalid input writes nothing, but an I/O failure may persist a truthful prefix for the home store while the git adapter is atomic.

## Acceptance

Run each criterion after adding its named regression cases (red before, green after). Queue helper, from the repo root:

```bash
q=we:scripts/readiness/heavy-admission.mjs
prove() { node "${q#we:}" run -- npx vitest run "${1#we:}"; }
```

- [A1] **Executable** — `prove we:scripts/lib/__tests__/verdict-ledger-store.test.mjs`: replace inline behavioral cases with JSON-driven append/read/fault/heal sequences covering promise API, capabilities, idempotent ids, ordering/from, invalid whole-batch refusal, identity isolation, unreadable reads and truthful partial-write counts; both existing home and real bare-origin git harnesses must execute every applicable vector. Missing vectors must fail the suite.
- [A2] **Executable** — `prove we:scripts/lib/__tests__/verdict-ledger-store.test.mjs`: add negative controls that run the same vector evaluator against adapters mutated to append duplicates or return empty success on read failure; assert each is rejected by a named vector, while the real adapters pass.

## Non-goals

- [N1] No adapter implementation changes, new store backend, stronger atomicity guarantee, or event-schema/derive-policy redesign.

## Edge cases this change must handle

1. **Untrusted text** — Invalid event payloads refuse the entire append; vector JSON is data and must not embed executable fixture callbacks.
2. **Truncated reads** — An unreadable medium returns unreadable with no rows; never substitute an empty successful ledger.
3. **Shared state files** — Declare shared and singleWriter capabilities; isolate filesystem and bare-origin fixtures rather than touching live stores.
4. **Fail closed** — Invalid row or mismatched repository writes zero rows; I/O failure reports exactly the prefix actually persisted, not assumed rollback.
5. **Identity scoping** — Retain mixed-repo rejection, missing/malformed repo refusal and colliding-slug read isolation from the existing suite.
6. **State over time** — Repeated ids within/across batches stay idempotent; reads preserve append order/from offset; heal after partial failure and retry without duplication.
7. **Who wrote it** — Preserve event source/id and declared store capabilities; transport does not authenticate actor declarations. No new endpoint: HTTP caps, CSRF/origin checks and reset-trigger limits are n/a.

## Grounding

- we:scripts/lib/verdict-ledger-store.mjs:7 defines the async contract, failure results and capabilities.
- we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs:24 contains the inline suite; :87 begins repository identity cases.
- we:scripts/lib/__tests__/verdict-ledger-store.test.mjs:36 creates the real home harness; :58 creates the bare-origin git harness; :73 runs both.
