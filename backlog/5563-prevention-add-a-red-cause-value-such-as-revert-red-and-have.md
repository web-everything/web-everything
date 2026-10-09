---
bornAs: xvq9t44
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib/revert-red-rule.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/revert-red-rule.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a red-cause value such as 'revert-red' and have classifyRedCause or the apply step set it. Ad… (from web-everything/web-everything#4535 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/verify-lane.mjs:742` — Add a red-cause value such as 'revert-red' and have classifyRedCause or the apply step set it. Add an assertion on `redCause` to the enforce case in we:verify-lane-revert-red.test.mjs. As a general guard, a lint or test that every code path that changes exitCode after the gate also sets a redCause.
2. `we:scripts/lib/revert-red-rule.mjs` — Gate on an end-to-end rule regression where an existing test is renamed, fails under reversion, and yields clean without another failing test.
3. `we:scripts/lib/revert-red-rule.mjs` — Add a deterministic regression with new, modified, and unchanged tests in one file; require the modified passing test to remain flagged despite failures in the other two.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4535@50fdb566d4a4c4043e9af1da9d03b06ab1762a48

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
