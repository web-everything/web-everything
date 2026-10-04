---
bornAs: xs2k0kt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/fixtures/shared-git-fixture.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a unit test beside the fixture that mutates every restored dimension and asserts equality wit… (from web-everything/web-everything#3914 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/fixtures/shared-git-fixture.mjs:60` — Add a unit test beside the fixture that mutates every restored dimension and asserts equality with the snapshot. A check:standards rule could also require a `*.test.mjs` for any new module under `scripts/__tests__/fixtures/`.
2. `we:scripts/__tests__/fixtures/shared-git-fixture.mjs:72` — Remove stale locks before Git writes and add a deterministic restoration test combining changed HEAD with a leftover HEAD.lock.
3. `we:scripts/__tests__/fixtures/shared-git-fixture.mjs:6` — Add a CI-run contract suite that perturbs each promised state component, restores it, and compares it with the snapshot, including unchanged-default and explicitly modified cases.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3914@42c75b15832673f4d6155e3a3510fc0ff2fa8a78

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
