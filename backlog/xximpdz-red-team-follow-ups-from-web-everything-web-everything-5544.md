---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-core.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5544 (head 6564d7cf0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5544 (reviewed head `6564d7cf0ad10da17b2448d80960d8fccc9a4692`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-core.mjs:1183` — (edge-case, degraded) The final validators omit the release-level policy and can block hardening the panel was instructed to defer.
   - Scenario: Set WE_REVIEW_CURRENT_LEVEL=internal-delivery and run /converge. For both security and correctness, buildPanelMandate includes the stanza but buildValidatorMandate omits it; we:converge-cli.mjs:483 uses the latter for final validation. In an isolated source probe, accepted mandatory-panel results produced action=red-team. Supplying a final-validator finding about missing external rate limiting, with introduced=true, worseThanBase=true and parallelizable=false, then produced action=escalate, verdict=changes, reason=round-cap at roundCap=1. Thus outside-attacker hardening explicitly deferred by the
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
