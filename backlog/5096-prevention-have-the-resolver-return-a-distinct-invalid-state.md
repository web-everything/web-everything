---
bornAs: xr1qspz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/heavy-run-ungated.mjs", "we:scripts/conveyor/__tests__/heavy-run-ungated.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Have the resolver return a distinct invalid state (or throw) for a set-but-rejected value and add… (from web-everything/web-everything#3947 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/heavy-run-ungated.mjs:143` — Have the resolver return a distinct invalid state (or throw) for a set-but-rejected value and add a CLI test asserting a non-zero exit. Alternatively, have the plist test assert the loop exits non-zero on invalid input.
2. `we:scripts/conveyor/__tests__/heavy-run-ungated.test.mjs:65` — Add an injectable sleep or interval-floor override via an env or flag used only in tests. Alternatively, keep the loop test at count=1 and unit-test the sleep gap separately.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3947@90bc75e5365c0a3879e7769b34b5ed0fc2abb7b8

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
