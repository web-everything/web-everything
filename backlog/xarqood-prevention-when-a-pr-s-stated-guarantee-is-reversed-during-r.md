---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/delivery-tier.mjs", "we:scripts/lib/__tests__/delivery-tier.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — When a PR's stated guarantee is reversed during review, reconcile the PR body with the test names… (from web-everything/web-everything#7416 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/delivery-tier.mjs:23` — When a PR's stated guarantee is reversed during review, reconcile the PR body with the test names. A review lens that cross-checks each Acceptance bullet against a named test would catch this.
2. `we:scripts/lib/__tests__/delivery-tier.test.mjs` — Require each behavioral Acceptance item to reference a named test and expected assertion; gate missing mappings and review whether the assertion supports the stated guarantee.
3. `(no file cited)` — Add a deterministic replay test against a pinned corpus and require it to pass whenever classifier rules change.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7416@e4d22f1063e077cb6a44a9840986fa20db78150a

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
