---
kind: story
locus: plateau-app
size: 2
status: open
blockedBy: ["3130", "3811"]
dateOpened: "2026-11-22"
tags: [plateau, release-gate, beta]
---

# First external access (beta) release gate

Release gate for the first external user of plateau-app (PL-BETA-GUARDS: the auth-route and deploy-gate hardening is parked until beta). No external user gets access until every blocker on this card is resolved: #3130 (auth-gated routes reachable logged off) and #3811 (deploy gate brute-force and session revocation). Add blockers here as new pre-beta hardening cards are found.

## Acceptance

- [A1] **Executable** — a check fails while any card in this card's blockedBy is not resolved and passes once all are resolved; no external user is given access before it passes.



## Non-goals

- [N1] Does not build the hardening itself; #3130 and #3811 do.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: gate card with no code of its own.
2. **Truncated reads** — n/a: gate card with no code of its own.
3. **Shared state files** — n/a: gate card with no code of its own.
4. **Fail closed** — n/a: gate card with no code of its own.
5. **Identity scoping** — n/a: gate card with no code of its own.
6. **State over time** — n/a: gate card with no code of its own.
7. **Who wrote it** — n/a: gate card with no code of its own.
