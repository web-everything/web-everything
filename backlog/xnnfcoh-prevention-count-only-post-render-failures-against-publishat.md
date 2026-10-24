---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-team-withheld-publish.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs", "we:scripts/lib/__tests__/red-team-withheld-publish.test.mjs", "we:scripts/conveyor/__tests__/advisory-label-sweep.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Count only post/render failures against publishAttempts and keep read failures on a separate time… (from web-everything/web-everything#5868 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-team-withheld-publish.mjs:66` — Count only post/render failures against publishAttempts and keep read failures on a separate time-based backoff. A test would drive two failed reads followed by a healthy read and expect a post.
2. `we:scripts/conveyor/advisory-label-sweep.mjs:168` — Wrap the early repo resolution in try/catch and fall back to the per-PR resolution. Add a sweep test with a throwing `currentRepo`.
3. `we:scripts/lib/__tests__/red-team-withheld-publish.test.mjs:60` — Add a negative-content assertion on persisted status and the escalation payload for the failure path.
4. `we:scripts/conveyor/advisory-label-sweep.mjs:183` — Extract one `safeErrorText(e)` helper, use it at every place the sweep records or logs an error message, and add a test with control characters and an overlong message.
5. `we:scripts/lib/red-team-withheld-publish.mjs:63` — Add the named canary regression test to the automated test gate, asserting against every status write and escalation payload.
6. `we:scripts/lib/red-team-withheld-publish.mjs:62` — Add a deterministic sentinel-exclusion regression test covering comment-read and post failures, and verify that deliberately persisting the thrown message makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5868@d81396f747ff94444f68f3f13acdf3a64cb971aa

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
