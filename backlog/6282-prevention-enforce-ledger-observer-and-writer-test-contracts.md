---
bornAs: xjdyood
kind: story
size: 3
status: open
scope: ["we:scripts/lib/ledger-observation.mjs", "we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/verdict-ledger-io.mjs", "we:scripts/check-standards.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention: enforce ledger observer and writer test contracts

PR #5492 requested prevention gates beyond its regression tests. Add a test-hygiene rule that rejects unstubbed gh subprocesses in unit tests; require live-read heads at callers of we:scripts/lib/ledger-observation.mjs; and inventory observation-guard call sites in we:scripts/lib/verdict-ledger.mjs and we:scripts/lib/verdict-ledger-io.mjs with a discriminating per-store mutation probe. Acceptance: an unstubbed gh spawn, a snapshot-only observation caller, and removal of each store guard are independently detected. Existing per-kind transport-retry tests and the observation-settings matrix remain required.

## Acceptance

- [A1] **Executable** — `npm run check:standards` detects a fixture caller that supplies only a list-snapshot head; restoring a live read clears that finding.
- [A2] **Executable** — affected unit tests refuse an unstubbed gh child before spawning it; an injected stub remains usable.
- [A3] **Executable** — independently removing the home-store and git-transport observation guards makes the corresponding per-store regression test fail, including a newer tip appearing between retries.
- [A4] **Must** — keep ordinary verdict writes and explicitly injected test transports working; incomplete guard inventories are reported rather than silently considered covered.

## Non-goals

- [N1] Do not change ledger verdict semantics, lifecycle settings, review labels, or production GitHub permissions.

## Edge cases this change must handle

1. **Untrusted text** — inspect call structure rather than trusting a comment that claims a live read.
2. **Truncated reads** — an incomplete inventory must report unknown coverage.
3. **Shared state files** — include both writer stores and a competing append between transport retries.
4. **Fail closed** — unit tests must refuse unstubbed external calls before execution.
5. **Identity scoping** — identify guards by store and function, preserving separate caller and per-store coverage.
6. **State over time** — cover stale snapshots, delayed first sightings, and observations invalidated by a later tip.
7. **Who wrote it** — n/a: these checks do not grant verdicts or alter actor attribution.
