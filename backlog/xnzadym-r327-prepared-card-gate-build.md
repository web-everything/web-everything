---
kind: story
size: 5
parent: "x9syioh"
status: open
scaffoldedBy: "r327-cards-ab-lane-26-fb353f00"
dateScaffolded: "2026-11-01"
blockedBy: ["x9syioh"]
scope: ["we:scripts/worker-brief.mjs", "we:scripts/lib/prepared-card-gate.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Build the prepared-card gate for worker-brief and build-dispatch

Build child of x9syioh. Policy, forks and defaults live there; this card holds mechanics only and is dispatched after the parent is ratified.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/__tests__/worker-brief.test.mjs` plus the new rule-table test pass: elevated-scope brief with no prepared linked card is refused; with a covering, non-whole-directory prepared card it renders.
- [A2] **Observable** — running we:scripts/worker-brief.mjs with `--purpose=x --files=we:scripts/lib/daemon-overlays.mjs` refuses after the change and rendered before; a `build-dispatch` dry-run holds an `operatorTask`-stamped elevated card. Before/after output in the PR.

## Non-goals

- [N1] No bypass flag. No change to low or none-care behaviour.

## Edge cases this change must handle

1. **Untrusted text** — per the parent card's threat model; this build reads structured fields only.
2. **Truncated reads** — unreadable input fails toward the hold or refusal.
3. **Shared state files** — n/a: derives from PR comments or card files on main; writes none.
4. **Fail closed** — per the parent card, edge case 4.
5. **Identity scoping** — per the parent card's Fork 2 or Fork 3 defaults.
6. **State over time** — per the parent card; staleness uses the existing shared rule.
7. **Who wrote it** — applies to agent and operator authors alike.

## Mechanics

- New pure module we:scripts/lib/prepared-card-gate.mjs: `(careBand, card, files, now) -> allow | refuse(reason)`, reusing the existing freshness rule (`preparedMaxAgeDays`, `preparedAgainstSha`) and a prefix-covering scope check; reject card scopes that are too wide: no entry shallower than a third-level directory (`scripts/` and `scripts/lib/` too wide, a leaf like `scripts/lib/daemon-rebuild/` allowed) and at most 10 entries (rationale: #6033 touched 83 files across a few directories; constants tunable here without a new ruling).
- Care estimator from declared files: daemon, gate, guard, statute or human-required paths are elevated or higher; no files declared is elevated and refuses with a request for files.
- `worker-brief` gains `--card=<id>` and refuses when the rule refuses. `build-dispatch` calls the same rule and does not count `operatorTask` stamps as prepared at elevated or high.
- Rulings and design notes are recorded as a card's origin field, never accepted as the link.
- PR-open re-check of the linked card against the real diff. Until it enforces, report that T1 is open.
- Mode setting starts `report-only`; flip to enforce after one clean week. Prototype-first for the daemon change; Codex read-only audit must say NOT WEAKENED.
