---
bornAs: xyz4r9d
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/lib/__tests__/drain-skip-reasons.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a contract test that feeds buildSkipReasons the real bucket shapes, taken from the producers'… (from web-everything/web-everything#4278 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-skip-reasons.mjs:62` — Add a contract test that feeds `buildSkipReasons` the real bucket shapes, taken from the producers' own fixtures, with non-null repos, and asserts exactly one row per PR. Also have the lib normalise repo keys (`repo || localSlug`) on both sides.
2. `we:scripts/lib/drain-skip-reasons.mjs:65` — Same contract test with a `--this-repo`-style null-repo verdict and a `parked` entry with `repo=localSlug`. Better still, add a `localSlug` param to `buildSkipReasons` and normalise both sides.
3. `we:scripts/lib/drain-skip-reasons.mjs:62` — Test that each `waitOn` token family (`required-check-read`, `couple-carrier:`, `incomplete-context`, `overlap-yield:`) maps to a sensible kind and keeps `x.reason`.
4. `we:scripts/lib/drain-skip-reasons.mjs:23` — Add a deterministic table-driven test covering UNKNOWN, BEHIND, DIRTY, BLOCKED, and DRAFT with the shared explanatory suffix; classify the actual state token separately from that suffix.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4278@2a48735782794071065fd6cc114520a7ab94bb6f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
