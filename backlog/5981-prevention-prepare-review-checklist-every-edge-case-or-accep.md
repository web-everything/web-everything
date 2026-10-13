---
bornAs: x35oysm
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Prepare-review checklist: every edge-case or acceptance bullet that asserts new runtime behaviour… (from web-everything/web-everything#5026 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md:55` — Prepare-review checklist: every edge-case or acceptance bullet that asserts new runtime behaviour must map to a Design or MVP line. This can ride on the #5989 contract test.
2. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md:88` — Prepare review should check that each injected option a test plan names exists on the entry point under test. This is a review lens, not a gate.
3. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md` — Add deterministic planned tests in we:scripts/readiness/__tests__/drain-lock.test.mjs for omitted configuration, valid overrides including zero, and invalid-value fallback; assert the wrapper's actual injected wait duration as well as resolver results.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5026@c57411e19ecf1e3c821bce7939ea120a16cedbd4

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
