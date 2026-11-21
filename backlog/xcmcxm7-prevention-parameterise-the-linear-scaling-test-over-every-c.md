---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-key-structure.mjs", "we:scripts/readiness/__tests__/forge-key-structure.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Parameterise the linear-scaling test over every comment opener (//, /*, and each line-terminator… (from web-everything/web-everything#7228 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-key-structure.mjs:43` — Parameterise the linear-scaling test over every comment opener (`//`, `/*`, and each line-terminator variant) with ratio assertions. Also call tick() inside startsObjectMember or afterTrivia so the step budget bounds the work. Preferably cache the next line terminator the way closeMemo does for block comments.
2. `we:scripts/readiness/forge-key-structure.mjs:152` — When a PR deletes a detection path and justifies it as 'covered elsewhere', require a paired test that exercises the input class through the remaining path. Review lens: justified removals need a test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7228@ba2aaa2510a14021ad079f49b7dedcfbf940181a

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
