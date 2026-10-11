---
bornAs: x8b63jx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/required-status-checks.mjs", "we:scripts/lib/__tests__/required-status-checks.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a test that pins the intended precedence (union versus rules-only) when both sources return c… (from web-everything/web-everything#4924 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/required-status-checks.mjs:128` — Add a test that pins the intended precedence (union versus rules-only) when both sources return contexts, and state the choice in the docblock. A review-lens note on 'multiple policy sources' is enough; there is no deterministic gate for this.
2. `we:scripts/lib/required-status-checks.mjs:118` — Add a unit test for the both-sources-configured case, asserting the intended semantics (union, or an explicit documented 'rulesets are authoritative'). Do this when the source-priority comment is written.
3. `we:scripts/lib/required-status-checks.mjs:121` — Pass `--paginate` (with `--slurp` or per-page JSON handling), or add a test that a response at the page-size boundary is handled. A lint rule flagging `gh api` list endpoints without pagination would catch the whole class.
4. `we:scripts/lib/required-status-checks.mjs:127` — Add a deterministic unit-test gate covering simultaneous ruleset and classic requirements with distinct contexts, asserting their union while retaining successful ruleset reads when classic protection is inaccessible.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4924@4540de775f05f6fa8c6dfe1d95902b3812345505

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
