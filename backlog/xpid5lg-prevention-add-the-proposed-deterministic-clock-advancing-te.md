---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/__tests__/gh-throttle.points-bucket.test.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/gh-throttle.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add the proposed deterministic clock-advancing test to the required throttle suite, asserting the… (from web-everything/web-everything#7522 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs` — Add the proposed deterministic clock-advancing test to the required throttle suite, asserting the returned elapsed time and refusal after the deadline.
2. `we:scripts/lib/__tests__/gh-throttle.points-bucket.test.mjs` — Add a repeatable representative-load verification gate with the two named tests asserting the corresponding gh-waitlog.jsonl measurements.
3. `we:scripts/lib/__tests__/gh-throttle.points-bucket.test.mjs` — Require the proposed deterministic tests in the throttle suite, asserting ticket removal at exactly 60 seconds, conservative recovery from actual sparse arrays, the reset log event, and preservation of future batch entries with otherwise sufficient tokens.
4. `we:scripts/lib/__tests__/gh-throttle.points-bucket.test.mjs` — Add a required table-driven test with lower-layer window values and invalid higher-layer overrides, asserting both the retained value and its provenance.
5. `we:docs/agent/testing.md:1062` — Add a review-lens rule: when a PR description has a 'Deviation from the prep' section, every doc sentence about the changed behaviour must be re-checked against the named deviation tests. A deterministic option is a test that pins the docs paragraph's recovery wording, for example one that fails if 'Missing' appears in the conservative-recovery sentence while the first-start test exists.
6. `we:scripts/lib/__tests__/gh-throttle.points-bucket.test.mjs` — Add a named wait-log acceptance checker asserting both thresholds, and require Acceptance guarantees to reference named checks.
7. `we:scripts/lib/__tests__/gh-throttle.points-bucket.test.mjs` — Add a deterministic boundary test with positive remaining headroom smaller than an explicit multi-point cost.
8. `we:scripts/lib/gh-throttle.mjs` — Add a deterministic deadline test with a clock-advancing adoption callback, and refresh deadline calculations after evidence collection.
9. `(cited file withheld: not a plain path)` — Add a named loaded-daemon-waitlog-thresholds check that evaluates representative load results and asserts both acceptance thresholds.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7522@a6f3d99734c4feda36d0e6f9f956051e302cf40c

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
