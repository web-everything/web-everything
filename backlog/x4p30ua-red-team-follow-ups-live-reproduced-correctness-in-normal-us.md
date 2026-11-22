---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/hotpatch-guards.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7361 (head 223209170)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7361 (reviewed head `223209170a49799b83dc10f9e1d33ae7b0551e23`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/hotpatch-guards.mjs:59` — (edge-case, degraded) An expired historical audit blocks a fresh valid audit indefinitely
   - Scenario: For one SHA and base, retain an older valid audit under a prior question hash whose acceptance window has expired, followed by a fresh NOT WEAKENED audit under QUESTION_HASH. findAudit selects the fresh record, but auditGuard validates each historical record separately and returns hotpatch-evidence-unreadable for the expired one. Further fresh audits cannot unblock admission. Expired historical hashes should be ignored when current valid evidence exists.
   - Class: live-reproduced (basis: Executed the unchanged auditGuard body with real findAudit and an expired prior-hash policy. findAudit selected the fresh audit, while auditGuard returned unknown before reaching canonical evidence evaluation. Removing only the historical record allowed the guard to pass.)
   - Also class: correctness-in-normal-use
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
