---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/lease-reaper.mjs", "we:scripts/conveyor/__tests__/lease-reaper.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a lint or checklist rule that every new try/catch fallback in a CLI shell needs a test that m… (from web-everything/web-everything#5846 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/lease-reaper.mjs:1535` — Add a lint or checklist rule that every new try/catch fallback in a CLI shell needs a test that makes the guarded call throw. Alternatively, put the claim-read wrapper in an exported function and unit-test it.
2. `we:scripts/conveyor/lease-reaper.mjs:1535` — Have stubs for guard-bearing calls record their arguments and assert them.
3. `we:scripts/conveyor/lease-reaper.mjs:1097` — When a PR description lists guards, reconcile them against the docblock before opening the PR. A deterministic gate is hard here; a review-lens note is enough.
4. `we:scripts/conveyor/lease-reaper.mjs:1145` — Make `nowMs` required, or default it to `Date.now()`, so the safe path is the default. Alternatively add a lint rule against helpers that default a freshness clock to null.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5846@62dbc0bc8e48754f54f900c1771ce28c7e55337c

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
