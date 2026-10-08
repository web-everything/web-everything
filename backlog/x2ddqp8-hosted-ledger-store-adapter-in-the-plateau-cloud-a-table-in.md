---
kind: story
size: 5
parent: "2445"
relatedTo: ["2742", "x3x7182"]
status: open
scope: ["we:scripts/conveyor/pr-events-worker/worker.mjs", "we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/lib/verdict-ledger-store.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Hosted ledger store adapter in the Plateau cloud: a table in the pr-events Durable Object

Ledger product review, operator 2026-10-08, D3 (option a). Free: git branch and home file adapters. Paid: a hosted adapter in the Plateau cloud, built as a new table in the existing pr-events Durable Object (we:scripts/conveyor/pr-events-worker/worker.mjs, which already has a single writer and a strictly increasing seq). It meets the same store contract and passes the same conformance suite (we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs). It ships with Plateau's first paid feature, remote/cloud coding: cloud sessions cannot read a Mac-local file. The standard and its tests are never paid. Gives #2742 its first concrete tenant.

## Acceptance

- [A1] **Executable** — the shared conformance suite (we:scripts/lib/__tests__/verdict-ledger-store-conformance.mjs) passes against the hosted adapter, run against a local worker; it fails before this item.
- [A2] Ledger rows live in a new table in the existing pr-events Durable Object, not a new service.
- [A3] Append is idempotent by event id; the single-writer guarantee is the Durable Object itself.
- [A4] The adapter registers under the store registry, so callers change only the store setting.
- [A5] Ships with Plateau's first paid feature, remote/cloud coding.

## Non-goals

- [N1] No query API or different store shape (D3 option c rejected).
- [N2] The standard and its conformance tests stay free.
- [N3] Billing and account work for the paid tier are not in this card.

## Edge cases this change must handle

1. **Untrusted text** — PR bodies and comments are data; nothing in them is executed or trusted as a verdict.
2. **Truncated reads** — a cut-off or failed read is unreadable, never empty.
3. **Shared state files** — writes go through the store contract's single-writer guarantee.
4. **Fail closed** — on unreadable state the gate holds, it does not merge.
5. **Identity scoping** — events are per repo and per PR head.
6. **State over time** — append-only; old rows are never rewritten.
7. **Who wrote it** — every event records its writer.
