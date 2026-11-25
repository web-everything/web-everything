---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-blocked-reason.mjs", "we:scripts/lib/__tests__/drain-blocked-reason.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a case where test is the sole failed required check and merge-gate is not failed, asserting a… (from web-everything/web-everything#7485 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/drain-blocked-reason.mjs:74` — Add a case where `test` is the sole failed required check and merge-gate is not failed, asserting a send-back and no re-run. As a class guard, run a per-clause mutation check on new suppression guards (item 3 of card x59d72k).
2. `we:scripts/lib/drain-blocked-reason.mjs:152` — Add a second-pass case with a new verdict id, one with a new head (each expects a new re-run), and an out-of-order comment list. The per-clause mutation check in card x59d72k item 3 covers the class.
3. `we:scripts/lib/drain-blocked-reason.mjs:159` — A check:standards gate mapping gh write verbs to the permission each caller role needs, as filed in card x59d72k, plus a live confirmation of the drain's grant.
4. `we:scripts/lib/drain-blocked-reason.mjs:161` — A review rule or shared helper that classifies gh write failures as transient or permanent before an irreversible-looking fallback, with a test for a null status.
5. `we:scripts/lib/drain-blocked-reason.mjs:147` — Derive the stale-lock threshold from the summed call timeouts (or give the section one deadline) and assert in a test that the threshold exceeds that sum.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5590, finding 7 → #5473, finding 8 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7485@7b1fd4daf7eb19c105d85ea9aed5c05fe6fff832

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
