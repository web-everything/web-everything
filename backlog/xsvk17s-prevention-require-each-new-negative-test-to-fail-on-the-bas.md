---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs", "we:scripts/conveyor/pr-stall-classify.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Require each new negative test to fail on the base commit. File the publication-marker card the P… (from web-everything/web-everything#7230 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs:701` — Require each new negative test to fail on the base commit. File the publication-marker card the PR names as its reinforce-later item.
2. `we:scripts/conveyor/pr-stall-classify.mjs:317` — Add a table-driven boundary and validator test for the pending condition and for each `CLASSIFY_VALID` leaf. A mutation-testing gate over `classifyStall` would catch this class.
3. `we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs:698` — Add a table-driven boundary test: age in {-1, 0, 45, 46, NaN, undefined}, trigger in {red-team-cap, referral-hold}, and an explicit non-default bound. Longer term, require a reject-case test for each CLASSIFY_VALID leaf.
4. `we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs:701` — Rename the test to what it actually pins. File the reinforce-later card for a publication marker, with a test that feeds an empty `latest` plus evidence that findings exist (for example `latestCount > 0`).
5. `we:scripts/conveyor/pr-stall-classify.mjs:317` — Persist a first-seen timestamp per (PR, head, trigger) in the sweep so the age cannot reset. This is the PR's own reinforce-later card. Add a test where successive cap records still escalate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7230@f7c7dcd376c6ff7a3ea6ccf46e69e7127a7bf361

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
