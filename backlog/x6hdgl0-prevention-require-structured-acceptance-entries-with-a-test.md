---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xuml6hx-s1e-env-narrowing-slice-needs-its-own-design-and-red-team-r1.md", "we:backlog/xu3hgnd-owed-ci-rerun-executor-residuals-exhausted-rows-soak-gap-rea.md", "we:backlog/xyr9b3a-st1-no-sensitive-settings-tier-1-test-lands-with-the-last-st.md", "we:backlog/x257iaz-pin-every-agy-snapshot-budget-and-actual-read-range.md", "we:backlog/xdszwjr-fix-daemon-should-ask-once-then-fall-back-to-a-worker-takeov.md", "we:backlog/x9pwgyp-reinforce-the-5-waived-forge-slots-capacity-findings-from-72.md", "we:backlog/x37fc7m-red-team-queue-requeue-loop-never-parks-16-requeues.md", "we:backlog/xzf2vxv-isolated-runner-redesign-for-confined-agy-build-pr-b-of-the.md", "we:backlog/xn1zac4-refuse-agy-repair-admission-without-loaded-item-evidence.md", "we:backlog/xgsc9dm-narrow-outbound-model-api-access-for-confined-agy-build-loop.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Require structured acceptance entries with a test-case name and explicit negative fixtures for ea… (from web-everything/web-everything#7291 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xuml6hx-s1e-env-narrowing-slice-needs-its-own-design-and-red-team-r1.md:15` — Require structured acceptance entries with a test-case name and explicit negative fixtures for each readiness condition.
2. `we:backlog/xu3hgnd-owed-ci-rerun-executor-residuals-exhausted-rows-soak-gap-rea.md:16` — Require budget test plans to declare the budget's unit and matching measured assertion; review elapsed-time limits separately from operation counts and byte limits.
3. `we:backlog/xu3hgnd-owed-ci-rerun-executor-residuals-exhausted-rows-soak-gap-rea.md:15` — Require each incident-derived acceptance case to assert both the intended action and absence of the reported unwanted side effect.
4. `we:backlog/xyr9b3a-st1-no-sensitive-settings-tier-1-test-lands-with-the-last-st.md:15` — Require non-exposure acceptance entries to identify and assert the actual output surface, with explicit, inherited and default input variants.
5. `we:backlog/x257iaz-pin-every-agy-snapshot-budget-and-actual-read-range.md:20` — Require a production-entry negative test whenever a card introduces test-only injection for an enforced limit.
6. `we:backlog/xdszwjr-fix-daemon-should-ask-once-then-fall-back-to-a-worker-takeov.md:21` — Require every acceptance plan that relaxes a hold to include a named negative case preserving each explicit exception.
7. `we:backlog/x9pwgyp-reinforce-the-5-waived-forge-slots-capacity-findings-from-72.md:16` — Require settings-resolution plans to cover explicit values, unset defaults and exhaustion of all configured sources with observable admission results.
8. `we:backlog/x37fc7m-red-team-queue-requeue-loop-never-parks-16-requeues.md:31` — Require each restart or changing-evidence guarantee to reference a named transition test with before-state, intervening change and after-action assertions.
9. `we:backlog/xzf2vxv-isolated-runner-redesign-for-confined-agy-build-pr-b-of-the.md:34` — Require isolation contracts to map concurrency and recovery guarantees to multi-run fixtures with identity-specific observable assertions.
10. `we:backlog/xn1zac4-refuse-agy-repair-admission-without-loaded-item-evidence.md:22` — Require provider-admission test matrices to distinguish explicit selection from effective default selection.
11. `we:backlog/xgsc9dm-narrow-outbound-model-api-access-for-confined-agy-build-loop.md:20` — Require every declared resource limit to map to a boundary test that measures the constrained resource, including response bytes and elapsed time.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5360, finding 9 → #5590.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7291@61e63e74cf4405f68b780fb1e9b898c56dfb4d2f

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
