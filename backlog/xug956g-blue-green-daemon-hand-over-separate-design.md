---
kind: epic
parent: "4075"
priority: high
status: open
blockedBy: ["xs4ewgh", "xt3sgtl", "xxynru6"]
scope: ["we:scripts/lib/daemon-rebuild/", "we:skills-src/conveyor/runner-lock.mjs", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Blue-green daemon hand-over (separate design)

Held item 194 (session 2026-10-09; operator: "yes but wait, too many PRs"; 2026-10-10: operator wants it next when capacity frees; priority high when filed). Today's swap restarts the daemon onto the new tree (gap plus slow first pass, e.g. the review daemon's 10-min first pass, card xbf7be9). After #4126 (rebuild+smoke as a background job): start the green daemon alongside on the candidate tree, warm it up, pass a live health check, then hand over the daemon lease (single holder always); blue stays on standby for instant rollback. Setting `swap: restart | blue-green` under the policy cascade. Deferred by R15 (operator 2026-10-10, after jury round 2, option a): blue-green gets its own design once the async task core is real. Related: #5036 (blue-green clone build and pointer switch, operator 2026-10-03, R10) and card 89 versioned clones (#4210, #4222; we:scripts/lib/daemon-version-switch.mjs, built and switched off, R11).

## Deferred design input (appendix of the async-daemons design, rev 2 -> rev 3)

None of this was in scope of the async-daemons design; it is input for this epic's own design.

- **Shape so far:** a green launchd label per color on versioned clones (card 89; blocked on its S7 overlays; open choice O5). Standby with a default-deny write gate (O12). A warm shadow tick, then a health gate, then a CAS transfer of the lease that bumps the epoch. Workers' claims are adopted by the new holder. 15-min probation; rollback by reverse transfer; retire. Statute amendment to R3 clause 1 (O10). Switch-on order, review first (O6). The drain stays on `restart` (O7). Standby until the end of probation (O8). The plan diff is only journaled (O9).
- **Open decisions carried in:** O5 green launch, O6 switch-on order, O7 drain in blue-green, O8 standby lifetime, O9 plan-diff gate, O10 R3 amendment, O12 standby sandbox.
- **Jury round 2 findings to carry in as required tests:**
  - J2-3: bidirectional schema compatibility, and verified blue warmth before rollback.
  - J2-6: attest the code the process actually loaded (pid -> path / argv), not just a directory.
  - J2-11: reattach dies mid-adoption, plus a stuck-claim age alert.
  - J2-15 / J2-23: bootstrap. The first BG-capable version arrives through a plain restart, and hand-over needs both colors to advertise the capability.
  - J2-20: list the writes the shadow tick itself needs, or give it a private snapshot; assert the warm plan is not empty.
  - J2-21: a cooperative transfer must not fence healthy in-flight tasks.
  - J2-25: unload the retired launchd label; a color that loses the lease re-enters deny.
- **What it builds on (from the async-daemons epic):** the L1 lease generation, the W1 claim hand-off with the `runId + handle` CAS, per-item task exclusion, and the run-store probes.

## Acceptance

- [A1] **Design first** — a blue-green design (own doc + jury review) covers the shape, open decisions O5-O10/O12 and every J2 finding above as a required test; then `/slice`.
- [A2] **Live** — one update hands over with no daemon pause longer than one tick, and a forced bad update rolls back automatically.

## Non-goals

- [N1] Re-deciding the async task core (settled in the sibling epic).
- [N2] Moving the drain off `restart` unless O7 rules so.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a at epic level: each slice card states its own handling.
2. **Truncated reads** — n/a at epic level: each slice card states its own handling.
3. **Shared state files** — n/a at epic level: each slice card states its own handling.
4. **Fail closed** — n/a at epic level: each slice card states its own handling.
5. **Identity scoping** — n/a at epic level: each slice card states its own handling.
6. **State over time** — n/a at epic level: each slice card states its own handling.
7. **Who wrote it** — n/a at epic level: each slice card states its own handling.
