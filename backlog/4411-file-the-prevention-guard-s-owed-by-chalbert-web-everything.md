---
bornAs: x47l8u4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-09-28"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2873's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/deliver-item-wrapper.mjs:1584` — A design pattern separating pure path resolvers from side-effecting mutators (e.g., exposing a pure `resolveConvergeScratchDir` for tests instead of the mutating wrapper).
2. `we:scripts/operations/deliver-item-wrapper.mjs:1605` — A check:standards rule flagging comments that make behavioral guarantees ('normalizes away', 'never a literal') without a corresponding test in the same file.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2873@a8010179e548da82fb8d1ad0b8b634b4f6d72387

## Ruling (operator, 2026-10-09 ~13:25 ET, same ruling as #4488)

The open choice from the prepare run (heuristic detection of behavioral prose vs explicit claim-to-test
references) is ruled: guarantee-style comments are handled by a **review lens**, not a `check:standards` rule.
The reviewer flags a behavioral guarantee in a comment; the author cites the defending test or marks it
`intentionally unguarded: <reason>`. Item 1 (expose the pure resolver for tests) is unaffected and buildable now.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
