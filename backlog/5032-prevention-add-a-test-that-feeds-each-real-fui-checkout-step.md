---
bornAs: xzb94k7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-auth-diagnosis.mjs", "we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a test that feeds each real FUI checkout step from we:ci.yml, we:deploy.yml and we:update-vis… (from web-everything/web-everything#3855 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-auth-diagnosis.mjs:98` — Add a test that feeds each real FUI checkout step from we:ci.yml, we:deploy.yml and we:update-visual-baselines.yml through the ci-auth-diagnosis token resolver and asserts it resolves to a rotation target (or that the `a || secrets.X` shape is explicitly supported). A check:standards rule that fails when workflow token expressions drift from what the diagnosis parser accepts would also work.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3855@80fe77e747c42ba91b61aa8367051cc93b8caa3e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
