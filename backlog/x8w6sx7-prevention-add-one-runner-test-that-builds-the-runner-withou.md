---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/sibling-base-check.mjs", "we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs", "we:scripts/lib/__tests__/sibling-base-check.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add one runner test that builds the runner without siblingBase but with the real default, injecti… (from web-everything/web-everything#7431 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/open-pr-io.mjs:167` — Add one runner test that builds the runner without `siblingBase` but with the real default, injecting only `gh` or `spawn` at a lower level. A lint rule could also flag injected-default factories whose default has no test.
2. `we:scripts/lib/sibling-base-check.mjs:31` — Fetch open PR heads, for example `refs/pull/*/head`, before the check. Alternatively, skip siblings that are not local and not ancestors, and record that in the detail. File this as a follow-up card, since the live replay is already listed as follow-up proof.
3. `we:scripts/operations/open-pr-io.mjs:253` — Add a test with hostile ref names for any code that interpolates external ref names into a copy-paste command. A lint rule that flags interpolating `headRefName` into a command string without a quote helper would catch the whole class.
4. `we:scripts/operations/open-pr-io.mjs:259` — Add a test that runs the runner with `--dry-run` and asserts the intended behavior, either that siblingBase is not called or that it is called. A gate-coverage check could require each admission gate to name its dry-run, check and publish behavior.
5. `we:scripts/lib/sibling-base-check.mjs:20` — Add the named merge-commit regression test to the automated suite.
6. `we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs` — Add parameterized regression cases asserting preservation of each explicitly promised gate.
7. `we:scripts/lib/sibling-base-check.mjs:23` — Add a deterministic regression test with a two-commit sibling squashed into main and an open overlapping sibling, asserting that the landed commits cause no refusal.
8. `we:scripts/operations/open-pr-io.mjs:261` — Add a deterministic runner test with contaminated HEAD, a clean --ref, no explicit --sha, and a clean canonical audit SHA; assert that no sibling blocker survives.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7431@0fb4c8f0b3c6a96bb88e04f5b925007fd0688caf

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
