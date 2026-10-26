---
bornAs: xge4c4p
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5890 (head 6a288f1a5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5890 (reviewed head `6a288f1a52cd880ad2a0c285aa647a6f35ecd15c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-job.mjs:300` — (edge-case, degraded) Admission crashes erase the unknown prior result and authorize a fresh pass
   - Scenario: Start with finished/result:null history, no seat rows, and no published result. Invoke fresh recovery, then kill its writer after queued admission but before the execution guard. Admission persists queued/result:null; the original finished/null provenance survives only in the in-memory admission object. Once the writer is dead, recovery now normalizes this queue to finished/null, the planner dispatches fresh, and the next admission clears its prior. An in-memory probe of the production admission, planner, normalization, and guard functions reproduced initial refusal followed by fresh dispatch
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
