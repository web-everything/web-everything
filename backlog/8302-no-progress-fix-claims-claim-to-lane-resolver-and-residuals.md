---
bornAs: x8cg7dr
kind: story
size: 5
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/conveyor/session-watchdog.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# No-progress fix claims: claim-to-lane resolver and residuals

Resume the parked no-progress fix-claim reclaim (PR #6854 closed under R88, branch lane/no-progress-reclaim kept at 34bbaa2d). Needs (b): an exported read-only lane-pool lease listing that preserves read errors (we:scripts/lane-pool.mjs; the lease reader is private and CLI status runs git probes and writes caches), plus a claim-to-lane resolver in we:scripts/conveyor/session-watchdog.mjs (claim meta lane/cwd first, else the lease matching the claim owner; fail closed on missing, ambiguous or unreadable; injected seam) so the escalation can fire for dispatched fixers that start in scratch directories. Open residuals: a running verify marker without startedAt authorizes reclaim (must hold); the soak break fixer-live-claim-no-progress-never-reclaimed uses a source-substring fixPresent that can flip to it.fails (use a behavioural check); the N+30 running-marker cap is by design (note it). Design: the operator handoff design note named no-progress-fix-claims (operations handoff folder, designs section).

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
