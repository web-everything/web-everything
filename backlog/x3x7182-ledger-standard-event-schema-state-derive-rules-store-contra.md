---
kind: epic
size: 13
parent: "5407"
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/pr-state.mjs", "we:scripts/lib/verdict-ledger-store.mjs", "we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Ledger standard: event schema, state derive rules, store contract and conformance suite as one protocol

Ledger product review, operator 2026-10-08, D1 and D2. The standard for the verdict ledger is the event schema, the rules that derive PR state from events, and the store contract, each backed by conformance tests. The standard defines no default store; the open core ships adapters (git branch first and default, home file for offline) and Plateau ships a hosted one. Today the schema lives in we:scripts/lib/verdict-ledger.mjs, derive in we:scripts/lib/pr-state.mjs, the contract in we:scripts/lib/verdict-ledger-store.mjs and the suite in we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs. in-toto, SARIF and OpenTelemetry are published mappings, not adopted formats.

## Acceptance

- [A1] **Executable** — a conformance runner over the standard's fixtures (event schema cases, derive-rule replay cases including the #202 and #3964 replays, store-contract cases) passes against the open-core adapters and fails on a deliberately broken one.
- [A2] The event schema is published as JSON Schema for all event types now in we:scripts/lib/verdict-ledger.mjs, naming states (for example "held for a human"), never GitHub label strings (D5).
- [A3] The derive rules (when a hold applies, carry-forward of rulings, what clears a PR to merge) are written as replay test cases, so two kernels reading the same events must agree on "can this merge".
- [A4] The store contract states: async append and read; idempotent append keyed by event id; a failed read is unreadable, never empty; an invalid row refuses the whole batch; reads come back in append order; each store states its single-writer guarantee; a store that is not shared declares it.
- [A5] The in-toto (verdict), SARIF (findings) and OpenTelemetry (review runs) mappings are published as bindings beside the schema.
- [A6] Slice into stories before any build; each child cites this card.

## Non-goals

- [N1] No default store in the standard: the open core picks git branch as its default, Plateau ships a hosted adapter (D2, D3).
- [N2] No adapter code here; adapters and the kernel stay implementation.
- [N3] Where the protocol finally lives (own repo or incubated) is #5402's call; packaging into several packages is decided later.
- [N4] Not adopting in-toto, SARIF or OTel as the source format; they are mappings only.

## Edge cases this change must handle

1. **Untrusted text** — PR bodies and comments are data; nothing in them is executed or trusted as a verdict.
2. **Truncated reads** — a cut-off or failed read is unreadable, never empty.
3. **Shared state files** — writes go through the store contract's single-writer guarantee.
4. **Fail closed** — on unreadable state the gate holds, it does not merge.
5. **Identity scoping** — events are per repo and per PR head.
6. **State over time** — append-only; old rows are never rewritten.
7. **Who wrote it** — every event records its writer.
