---
bornAs: xwuq7yd
kind: story
size: 3
status: open
scope: ["we:scripts/lib/"]
dateOpened: "2026-11-09"
tags: []
---

# Per-PR ownership of the red-team check when PRs share a SHA so policy-clear publication is not blocked (R789 break)

Red-team break on #6535 (confirmed, liveness only, ruled under R789 and R794): when two PRs share a head SHA, a successful check bound to the other PR makes policy-clear publication in we:scripts/lib/red-team-check-run.mjs return ok:false with zero POSTs, stranding the second PR. Bind each check to its own PR via external_id and create the PR own check when absent, without superseding the other PR evidence. Design context: operator handoff design note for the 6535 follow-ups.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/red-team-check-run.test.mjs` passes: with PR 7 success on a shared SHA, PR 8 policy-clear publishes its own check; PR 7 check is untouched.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the in-progress race guard or the carry and ruling republish cards.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
2. **Truncated reads** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
3. **Shared state files** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
4. **Fail closed** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
5. **Identity scoping** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
6. **State over time** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
7. **Who wrote it** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).

## Duplicate admission

Distinct R789 liveness follow-up from the 6535 red-team sweep
