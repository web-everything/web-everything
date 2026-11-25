---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x7otjhx-a-merge-gate-red-older-than-the-exact-head-clear-human-must.md", "we:backlog/x99glld-stand-down-crashes-after-posting-its-comment-circular-dynami.md"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Extend the planned we:scripts/__tests__/stale-gate-verdict.test.mjs with named cases unreadableMe… (from web-everything/web-everything#7500 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/x7otjhx-a-merge-gate-red-older-than-the-exact-head-clear-human-must.md:17` — Extend the planned we:scripts/__tests__/stale-gate-verdict.test.mjs with named cases unreadableMetadataKeepsRed, ineligibleFailuresStillBounce, incompletePagesKeepRed, rerunFailureKeepsHeld, mismatchedIdentityRejectsException, newerPushVoidsException, untrustedClearanceIsIgnored, and exceptionNeverGrantsClearance, each asserting the corresponding writes or their absence. Add a deterministic card-validation gate requiring behavioral requirement IDs to map to a test file, case name, and observable assertion.
2. `we:backlog/x99glld-stand-down-crashes-after-posting-its-comment-circular-dynami.md:28` — Add planned cases in we:scripts/conveyor/__tests__/stand-down-cli.test.mjs: releasePreservesOtherSessionsClaims, releaseFailureReportsAndPreservesComment, labelFailureReportsAndPreservesComment, releaseRequiresWhoAndKnownRepo, crashedRunClaimStillExpires, commentBodyUnchanged, and terminalStopClassificationUnchanged. Assert retained unrelated claims, observable error reporting and comment preservation, rejected invalid identity inputs, expiry, and unchanged outputs/classification respectively. Require these mappings through a deterministic behavioral-requirement-to-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7500@76bcc6a9c6bfaaf50a91b2575aa14d05da4e2934

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
