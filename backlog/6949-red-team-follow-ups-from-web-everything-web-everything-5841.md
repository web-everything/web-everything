---
bornAs: x46yxbx
kind: story
size: 2
status: open
scope: ["we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5841 (head 408199eb7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5841 (reviewed head `408199eb7988916066aa0a10e2beed9dd9c8defc`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/review-set-label.mjs:1824` — (edge-case, degraded) A rearm refused for human clearance can already have superseded that clearance in the ledger
   - Scenario: An ordinary rearm initially reads H with review:human and review:changes and no clearance. Before its ledger append, the operator completes clear-human on H, recording the clearing verdict and trusted comment and restoring review:accepted. Rearm then appends pending at lines 1851–1854. Its new pre-swap clearance check detects the operator comment and exits 1, but does not retract the pending verdict. A probe using an in-memory append sink and the real foldVerdictLedger produced rows [clear-human, pending] and current verdict pending with clears:false, despite the explicit human-clearance refus
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
