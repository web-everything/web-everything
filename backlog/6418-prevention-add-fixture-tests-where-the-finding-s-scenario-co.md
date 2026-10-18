---
bornAs: xdyn4pm
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/coroner-false-findings.mjs", "we:skills-src/coroner/SKILL.md", "we:scripts/operations/__tests__/coroner-false-findings.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add fixture tests where the finding's Scenario contains cause keywords ('stale', 'already present… (from web-everything/web-everything#5454 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/coroner-false-findings.mjs:28` — Add fixture tests where the finding's Scenario contains cause keywords ('stale', 'already present') and the Re-check says diff-only. Separately, parse the Re-check line into its own field and run the rules on that field only.
2. `we:skills-src/coroner/SKILL.md:115` — Have one workflow entry point produce the report and census artifact, with an injected-collector test asserting that collection occurs once.
3. `we:scripts/operations/__tests__/coroner-false-findings.test.mjs:50` — Add the named deterministic test to the existing suite, injecting a files-only request failure while discovery and comments succeed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5454@a79b7c5db7aa2418749eb3ae99aa2925e51d9fb4

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
