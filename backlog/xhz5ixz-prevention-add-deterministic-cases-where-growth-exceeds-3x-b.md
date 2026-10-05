---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/rebase-drop-manifest.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add deterministic cases where growth exceeds 3x but remains below or exactly at +25, and require… (from web-everything/web-everything#3881 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/rebase-drop-manifest.test.mjs:467` — Add deterministic cases where growth exceeds 3x but remains below or exactly at +25, and require those cases to pass in the existing unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3881@c86abfec6aa0ff76f4e38031904064ae45f50bdd

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
