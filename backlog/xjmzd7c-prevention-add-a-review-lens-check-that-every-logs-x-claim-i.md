---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/pr-land.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a review-lens check that every 'logs X' claim in a PR body has a stderr or log assertion. A d… (from web-everything/web-everything#7235 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/pr-land.mjs:1262` — Add a review-lens check that every 'logs X' claim in a PR body has a stderr or log assertion. A deterministic gate is not practical here.
2. `we:scripts/merge-ai-prs.mjs:6549` — Add a test that a drain run with no clone parks with a reason containing 'net diff unverified (no-clone)'. State the behaviour change in the PR body.
3. `we:scripts/pr-land.mjs:1256` — A mutation or call-site-coverage lint on guard helpers: every call of an assert*/guard helper needs a test that fails when that call is removed. Failing that, a review-lens checklist item saying one test per guard call site.
4. `we:scripts/pr-land.mjs:1249` — Add a stderr assertion to the open-only runCli test in we:pr-land.test.mjs. Longer term, an acceptance-to-test mapping check for log-line guarantees.
5. `(no file cited)` — Require each Acceptance guarantee to reference a named test or executable acceptance procedure and its evidence; add named live score-equivalence, combined-contamination, and landing-SHA-log checks.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7235@1515ded99162e1daab27cdae70356b323e6f606d

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
