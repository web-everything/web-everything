---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-shadow-agreement.mjs", "we:scripts/lib/agy-shadow-trial-report.mjs", "we:scripts/lib/__tests__/review-shadow-agreement.test.mjs", "we:scripts/lib/__tests__/agy-shadow-trial-report.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Clamp and scrub path (length cap plus scrubPaths) in buildShadowRow. Add a test that feeds a 10k-… (from web-everything/web-everything#5228 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-shadow-agreement.mjs:119` — Clamp and scrub `path` (length cap plus `scrubPaths`) in `buildShadowRow`. Add a test that feeds a 10k-character absolute-path `file` and asserts the stored `path` is bounded and contains no local path.
2. `we:scripts/lib/agy-shadow-trial-report.mjs:43` — Use a Map or `Object.create(null)` for `byLens`. Add a report test with `lens: '__proto__'` that asserts `Object.prototype` is unchanged.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5228@0518f4ddcb721bcd7241df1b5de00fe36bb67688

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
