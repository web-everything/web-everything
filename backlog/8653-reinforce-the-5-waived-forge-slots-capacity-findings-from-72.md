---
bornAs: x9pwgyp
kind: task
status: open
scope: ["we:scripts/lib/forge-slots.mjs", "we:scripts/readiness/__tests__/forge-slots.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Reinforce the 5 waived forge-slots capacity findings from #7267

#7267 waived forge-slots capacity findings to reinforce: the Python fallback, a cascade-missing case that is silent, and FORGE_EXEC_SLOTS skipping the operator layer. Source: build-queue 21:58 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `resolves slot capacity through Python fallback` in `we:scripts/readiness/__tests__/forge-slots.test.mjs`: Make the primary resolver unavailable; assert the Python fallback returns the configured capacity and records its fallback reason.
- [A2] **Executable** — Planned `reports missing settings cascade` in `we:scripts/readiness/__tests__/forge-slots.test.mjs`: Remove cascade evidence; assert an explicit missing-cascade diagnostic rather than silently treating it as a configured value.
- [A3] **Executable** — Planned `resolves FORGE_EXEC_SLOTS from operator layer` in `we:scripts/readiness/__tests__/forge-slots.test.mjs`: Set conflicting lower-layer and operator values; assert the operator value wins and its source is reported.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No default capacity increase.

## Edge cases this change must handle

1. **Untrusted text** — Setting values are parsed as data.
2. **Truncated reads** — Missing cascade evidence cannot silently select capacity.
3. **Shared state files** — n/a: capacity resolution need not write shared state.
4. **Fail closed** — An unusable capacity source blocks admission with a visible fallback reason.
5. **Identity scoping** — Resolve settings for the intended operator context.
6. **State over time** — Re-resolve when effective settings change.
7. **Who wrote it** — Log the effective capacity source.

## Duplicate admission

new card from build-queue CARD line
