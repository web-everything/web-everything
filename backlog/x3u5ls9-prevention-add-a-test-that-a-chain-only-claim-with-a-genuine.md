---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a test that a chain-only claim with a genuinely conflicting, non-containing candidate does no… (from web-everything/web-everything#4923 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/daemon-overlay.mjs:134` — Add a test that a chain-only claim with a genuinely conflicting, non-containing candidate does not silently set the base aside. Or require the candidate to share a merge-base with the base tip. A lint cannot cover this; it is a review lens or test.
2. `we:scripts/daemon-overlay.mjs:503` — Call stackBases only when the first preview is not clean, and bound the total gh budget below the lock wait. Add a test asserting stackBases is not called when the preview is clean.
3. `we:scripts/daemon-overlay.mjs:119` — Standards rule: env-var overrides in scripts/ must be documented in the file header or prefixed WE_TEST_.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4923@e188eebf410f99e2d00162a808148effc3a9a57b

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
