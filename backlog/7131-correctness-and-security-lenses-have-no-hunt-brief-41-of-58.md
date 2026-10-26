---
bornAs: x44d86e
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Correctness and security lenses have no hunt brief; ~41 of 58 breaks nobody raised

[held entry 296] (coroner 2026-10-13, held) Correctness and security lenses have no hunt brief; ~41 of 58 breaks nobody raised. Recurring classes: failed side effect recorded as success (~9), starvation/capacity (~9), paging and caps first:100/500 rows (5), one hold masking an unrelated failure (~7), latest-vs-earlier races (~6), ID variants (4), untrusted text in classifiers (4). Fix idea: LENS_HUNT_BRIEF entries for correctness + security (we:review-core.mjs ~1935) listing these classes; seed precedents once #5243 lands: prec-5195-failed-side-effect-is-not-success, prec-5241-paginate-and-no-starvation, prec-5082-hold-must-not-mask-other-failures, prec-5038-id-format-variants, prec-5045-untrusted-text-in-classifiers, prec-5223-race-is-not-theoretical. Measure: red-team breaks per accepted head before/after. Evidence: scratchpad redteam/analysis.txt. Scope: we:scripts/lib/review-core.mjs, we:scripts/review-precedents.seeds.json. Size 3. | [held entry 297] (coroner 2026-10-13, held) Review scope misses code outside the diff and skips lenses. ~7 breaks sit in interaction with unchanged code (#5082, #5235-2719, #5185-413: a hold masks other checks); #5129 (security control spec) had no security seat; every review today logged "SHORTFALL: standards-conformance, claim-accuracy did not sit" (#5245 spec break is claim-accuracy). Fix idea: judge input adds callers of changed exports and sibling holds/gates in the same reconcile path; keep the security seat on prose/spec PRs that design a control; find why the routed claim-accuracy/standards seats (#4194) never sat and alarm on it. Drop the "diff-only" wording from the tool-bearing codex seat prompt. Evidence: review comments 2026-10-13 (SHORTFALL line). Scope: we:scripts/operations/review-pr.mjs, we:review-dispatch.mjs. Size 5.

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
