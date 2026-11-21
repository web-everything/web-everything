---
bornAs: xh2689e
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xmokcam-prevention-card-lint-plus-review-lens-when-prose-enumerates.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a deterministic card-lint gate requiring each Acceptance ID to reference a repository-qualifi… (from web-everything/web-everything#5543 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6262-prevention-card-lint-plus-review-lens-when-prose-enumerates.md:24` — Add a deterministic card-lint gate requiring each Acceptance ID to reference a repository-qualified named test or concrete planned test with an observable assertion.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5615.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5543@0ca32190d97146554b48e1f39d0d2a3bb34e1860

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

## Also raised by

- Also raised by web-everything/web-everything#7227, advisory review of head `d52ac6f729893b0f27a7924d872e8ae6e10b38ad` on 2026-11-21: correctness/coverage, security/coverage, simplicity/COVERAGE and codex-correctness/coverage at `we:scripts/operations/__tests__/urgent-sweep.test.mjs`. Require each operational Acceptance guarantee and Risks bullet to reference a repository-qualified named integration test with an observable assertion, or a named live verification procedure and its recorded artifact path. Check the mapping before clearance; a procedure alone is a plan, not a passing live-proof receipt.
- For that prevention gate's fixtures, cover the three hot-patch procedures: `live green hot-patch lifecycle` (actual health-watch ticks, request during running CI, adoption, green CI, merge and settlement); `live red canary unloads within five minutes` (failure-to-withdrawal elapsed time at most five minutes); and `live head move cancels CI and unloads` (push during CI, cancelled run, withdrawal). Recorded live artifacts must identify the PR and immutable patch SHA, ET timestamps, before/after daemon `rev-parse` values, and the observed terminal state. Include the replacement `hotpatch/<sha>-auto-1` ref risk with a named test asserting NEEDS-YOU escalation and no removal.
- Negative fixtures must reject a missing mapping, a nonexistent test or artifact, a direct mocked sweep presented as full live proof, and a red-canary receipt without elapsed-time or daemon-SHA evidence. Keep planned verification distinct from completed verification. This records prevention debt only: it neither supplies PR #7227's pending live proof nor changes its current not-real rulings or human-review requirement.

Idempotency key (do not edit): advisory-prevention-key:web-everything/web-everything#7227@d52ac6f729893b0f27a7924d872e8ae6e10b38ad:operational-acceptance
