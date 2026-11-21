---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-slots.mjs", "we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs", "we:scripts/readiness/__tests__/forge-slots.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a CLI test that copies we:scripts/readiness/forge-slots.mjs and we:forge-slots.json to a temp… (from web-everything/web-everything#7267 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-slots.mjs:43` — Add a CLI test that copies we:scripts/readiness/forge-slots.mjs and we:forge-slots.json to a temp dir without we:lib/policy-cascade.mjs and asserts the default is returned. Tighten the check to compare the missing module's resolved path with we:policy-cascade.mjs, or use the file URL that failed. Covered by the existing reinforce-later card for flat deployments.
2. `we:scripts/readiness/forge-slots.mjs:42` — Check that the missing specifier ends in we:lib/policy-cascade.mjs (parse it from the message or use error.url), or `existsSync` the module path before importing and let any import error throw. Add a test where policy-cascade is present but a dependency is missing, and assert exit 1.
3. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:63` — Add a rule that every catch that returns a permissive value needs a test naming both the allowed and the refused error shape. This could be a review lens, or a `check:standards` rule if it is script-decidable.
4. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:22` — Extend the named test with conflicting host values and an unrelated repository host, making merge precedence a deterministic test gate.
5. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:56` — Add a deterministic CLI test using a directory as the preferences-file path to exercise filesystem read failure independently of JSON parsing.
6. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:51` — Add a deterministic filesystem-read-error fixture to the CLI test suite and require it in CI alongside the malformed-JSON case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7267@921295916309d2c91aea03728fcf9095f24d50ff

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
