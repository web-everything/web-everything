---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:config/platformDefaults.ts", "we:config/__tests__/config-contract.test.ts", "we:config/defineConfig.ts", "we:scripts/lib/gate-config.mjs", "we:config/__tests__/platformDefaults.test.mjs", "we:config/__tests__/defineConfig.test.mjs", "we:scripts/lib/__tests__/gate-config.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a check:standards rule or contract test asserting that every re-export of PLATFORM_DELIVERY_P… (from web-everything/web-everything#5935 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:config/platformDefaults.ts:158` — Add a check:standards rule or contract test asserting that every re-export of PLATFORM_DELIVERY_POLICY_DEFAULTS resolves to we:config/deliveryPolicyDefaults.ts. Alternatively, register the re-export files at policy tier.
2. `we:config/__tests__/config-contract.test.ts:176` — Extend the AST walk to reject CallExpression with an import or require callee and ImportEqualsDeclaration in that file.
3. `we:config/defineConfig.ts:172` — Add a deterministic loader contract test comparing resolved partial overrides with all omitted platform defaults.
4. `we:scripts/lib/gate-config.mjs:810` — Add deterministic subprocess-boundary tests covering a nonterminating registry and excessive stdout, with explicit timeout and byte-limit assertions.
5. `we:scripts/lib/gate-config.mjs:818` — Add a deterministic command-boundary test that moves the ref after resolution and verifies both reads remain pinned to the original commit.
6. `we:scripts/lib/gate-config.mjs:810` — Add deterministic subprocess fixtures for timeout and oversized output, asserting null and bounded completion, and verify that removing each corresponding limit makes its named test fail.
7. `we:scripts/lib/gate-config.mjs:819` — Add a deterministic test that advances a branch between file reads and asserts both files still come from the initially resolved commit; mutation-check replacing the pinned commit with the supplied ref.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5935@5041223f992dde91a4c8d67045af94fdc80e16d4

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
