---
bornAs: xz6s6kx
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5865 (head 51082546a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5865 (reviewed head `51082546a18b5377daf60cdf1f0c4647fcdfd9a2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:2057` — (edge-case, degraded) A crashed non-human resume bypasses the one-resume attempt bound
   - Scenario: Reproduced through the real enrichment chain and planner using captured thread #5800 with review:human replaced by review:pending before enrichment. Within the verdict grace window, its one completed review produces a same-head hold and dispatches the newly allowed resume. If that resumed review then dies after recording its head, append an incomplete run with completedAt:null, incomplete:true, parked:false, attempted:false, persistenceFailed:false and no new wake event. On the next tick, verdictNeverLanded treats the incomplete non-human run as missing a verdict; decideSameHeadHold returns nu
   - Claude's re-check: demonstrated break

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
