---
bornAs: x0z2ejt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:config/__tests__/config-contract.test.ts", "we:backlog/4880-a-codex-mandatory-seat-on-every-claude-authored-pr-so-one-bl.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Run tsc --noEmit over the config tests, for example with vitest typecheck or expectTypeOf. Alternativel… (from chalbert/web-everything#3789 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:config/__tests__/config-contract.test.ts:47` — Run `tsc --noEmit` over the config tests, for example with vitest typecheck or `expectTypeOf`. Alternatively, add a runtime policy-set constant that the resolver and tests both import.
2. `we:backlog/4880-a-codex-mandatory-seat-on-every-claude-authored-pr-so-one-bl.md:43` — Add a design-step line and a RED test in card 4880/4880: the policy is resolved from the base ref only, and a head-branch config change must not alter it. Longer term, a lint requiring cards that add a gate-weakening config option to state its trust source.
3. `we:config/__tests__/config-contract.test.ts:58` — Add an exact assertion that PLATFORM_CROSS_PROVIDER_FALLBACK_WAIT_TIMEOUT_MS equals 24 * 60 * 60 * 1000 to the config contract test.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3789@6f75d80dc455c51c3d0ab9cbe435aa886fc6d57f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
