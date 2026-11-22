---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-slots.mjs", "we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs", "we:scripts/readiness/__tests__/forge-slots.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a test that runs the CLI from a temp dir containing only we:scripts/readiness/forge-slots.mjs… (from web-everything/web-everything#7267 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-slots.mjs:43` — Add a test that runs the CLI from a temp dir containing only `we:scripts/readiness/forge-slots.mjs` and `we:forge-slots.json`. Match the missing-module specifier exactly, not by substring. Make it a standing test for flat-deployment behaviour.
2. `we:scripts/readiness/forge-slots.mjs:47` — Have `forge-setup.sh` log the resolved operator file path and whether it was found. Alternatively require an explicit `WE_PLATFORM_PREFERENCES_FILE` for Forge hosts. File this under the existing reinforce-later card.
3. `we:scripts/readiness/forge-slots.mjs:43` — Check the specifier or URL of the failed import (the path in the message before 'imported from'), not the whole message. A unit test could inject a cascade stub whose own dependency is missing. A lint rule banning `.message.includes` for ERR_MODULE_NOT_FOUND discrimination would catch the class.
4. `we:scripts/readiness/__tests__/forge-slots-operator-layer.test.mjs:63` — Review lens: every catch that swallows an error class needs a test that triggers it and a test that triggers a neighbouring error to confirm it still rethrows.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7267@53dcdc877558e39425934f171242c6a2c578bd53

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
