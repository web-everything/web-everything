---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a deterministic parameterized timeout test covering wait budgets above the busy cap and busy… (from web-everything/web-everything#3880 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-live-smoke.mjs:243` — Add a deterministic parameterized timeout test covering wait budgets above the busy cap and busy caps below the default wait, then enforce a consistent cap and child wait policy.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3880@900403a39bf732271c54a05ae1b738f49e97f049

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
