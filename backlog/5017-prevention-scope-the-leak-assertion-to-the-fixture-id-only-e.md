---
bornAs: xg8mw18
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/check-backlog-item.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Scope the leak assertion to the fixture id only (expectNoRealFixture, which already exists) and drop th… (from chalbert/web-everything#3817 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/check-backlog-item.test.mjs:62` — Scope the leak assertion to the fixture id only (`expectNoRealFixture`, which already exists) and drop the whole-directory status equality. A review lens is enough; no deterministic gate fits this class.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3817@acefe588463be7c7ba986017b752e87caf47223b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
