---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-slots.mjs", "we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs", "we:scripts/readiness/__tests__/forge-slots.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Match the failing specifier exactly, for example by checking that error.url or the quoted module… (from web-everything/web-everything#7267 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-slots.mjs:43` — Match the failing specifier exactly, for example by checking that error.url or the quoted module path in the message ends in we:lib/policy-cascade.mjs. Add a CLI test that copies we:scripts/readiness/forge-slots.mjs to a temp dir with no cascade beside it. A check:standards rule requiring a test per catch-and-continue branch would cover the whole class.
2. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:23` — Add a case with a colliding host name to the merge test. Optionally add a rule that overlay or merge functions need a collision test.
3. `we:scripts/readiness/forge-slots.mjs:43` — Test the flat-deployment branch directly. Compare the missing path from error.url, or resolve the module with import.meta.resolve and check the file exists, rather than matching message text.
4. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:63` — For each Acceptance guarantee in a card, require a named test that feeds the invalid-value variant and the absent-dependency variant, as a review-lens checklist item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7267@875754bd917281fd21e8eefc6678ac0caf377d8a

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
