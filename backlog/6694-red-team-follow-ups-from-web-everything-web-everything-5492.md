---
bornAs: x6pqiac
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ledger-observation.mjs"]
dateOpened: "2026-10-19"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5492 (head 3c668c199)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5492 (reviewed head `3c668c1997a2a0c37974d65f82cdb00d239440e6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ledger-observation.mjs:179` — (edge-case, degraded) Unbaselined PRs can indefinitely starve later head invalidations
   - Scenario: Set firstSeenRows=false, headMoveInvalidation=true, and drainObserveMaxPerPass=20. Supply a stable ordered list of 21 open PRs: PRs 1–20 have no ledger rows; PR 21 has accepted(A), but its listed and live head is B. Every pass reads PRs 1–20, writes no baselines because firstSeenRows is disabled, and caps PR 21. A read-only three-pass probe produced zero reads of PR 21 and left its witnessed head at A throughout. This repeats indefinitely despite logging 'retried next pass'. Enabled head invalidations should eventually receive budget, through fair scheduling or skipping observations whose appl
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
