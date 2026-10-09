---
bornAs: xek911r
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib/verify-revert-red.mjs", "we:scripts/lib/revert-red-rule.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/verify-revert-red.test.mjs", "we:scripts/lib/__tests__/revert-red-rule.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add an e2e assertion on redCause/redCauseFiles for the enforce-red and not-restored paths. Better… (from web-everything/web-everything#4535 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/verify-lane.mjs:757` — Add an e2e assertion on redCause/redCauseFiles for the enforce-red and not-restored paths. Better, give classifyRedCause a 'revert-red' cause input rather than letting it fall through to 'infra'.
2. `we:scripts/lib/verify-revert-red.mjs:96` — Add a recovery test where HEAD moves while the file still holds the journaled reverted hash. Decide whether that case should restore from the journaled head or be reported as unverified.
3. `we:scripts/lib/revert-red-rule.mjs` — Add a deterministic regression test with two same-leaf declarations and only the nested test failing; require the parent test to remain flagged or unproven.
4. `we:scripts/lib/verify-revert-red.mjs` — Add a deterministic prefix-edit preservation test and refuse ambiguous contents unless journaled write-state evidence establishes that recovery owns them.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4535@fcc29ce1d5b108576ed06d04d0925e4b77ef6132

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
