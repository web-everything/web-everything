---
bornAs: xln4o33
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/delivery-policy.mjs", "we:scripts/lib/__tests__/delivery-policy.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Extend the xg5936p review rule to require one cache-warm, authorization-only-change test per trus… (from web-everything/web-everything#5936 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/delivery-policy.mjs:14` — Extend the xg5936p review rule to require one cache-warm, authorization-only-change test per trust check the comment names, not per comment.
2. `we:scripts/lib/delivery-policy.mjs:239` — Route every failsafe return through one helper that both warns and journals. Add a test assertion that every failsafe test checks readPolicyEvents.
3. `we:scripts/lib/__tests__/delivery-policy.test.mjs:125` — Apply the guard-isolation review rule already filed as card xg5936p: each guard-named test needs a positive control and an assertion that fails if only that guard is removed. Longer term, add a mutation-smoke check for trust-boundary modules.
4. `we:scripts/lib/delivery-policy.mjs:96` — Apply the cache-hit revalidation rule in card xg5936p (A2): every 'never cached' trust promise must map to a named test with content and mtime held fixed, one per authorization axis.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5360, finding 6 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5936@b6a414a7a9a674eed369bc12b058ccb7d3125077

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
