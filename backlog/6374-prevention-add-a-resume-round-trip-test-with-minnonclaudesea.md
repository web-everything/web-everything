---
bornAs: xbi85wp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/lib/review-seat-provider.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/lib/__tests__/review-seat-provider.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a resume round-trip test with minNonClaudeSeats: 2 that starts a run, then rebuilds the decla… (from web-everything/web-everything#5441 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr.mjs:2376` — Add a resume round-trip test with `minNonClaudeSeats: 2` that starts a run, then rebuilds the declaration through `advanceReviewPrToWriteUp`. Better, derive `correctnessAdvisory` from the saved run, as `codexAdvisoryFromRun` does for `codexAdvisory`.
2. `we:scripts/lib/review-seat-provider.mjs:143` — Make absent shadowPolicy mean off (or throw), and give the test fixtures that need a live shadow an explicit policy. Add a test that settingsFromRoutingPolicy output alone yields no directive.
3. `we:scripts/operations/__tests__/review-pr.test.mjs:4748` — Add an operation-level test that enables shadows, picks a repo#pr in the sampled bucket, and asserts request.seatProvider is non-null for both mandatory lenses.
4. `we:scripts/operations/review-pr.mjs:2379` — Count enabled options through Boolean conversion and add a deterministic parameterized regression test covering boolean and provider/model settings with minimum two, asserting both Codex judge steps exist.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5441@b90a1a51079ec0ef4aed69d8b41b7e5c6ff305a9

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
