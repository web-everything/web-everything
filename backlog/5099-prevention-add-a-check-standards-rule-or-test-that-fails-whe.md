---
bornAs: xa2aec3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/smoke-expired-gh-token.mjs", "we:scripts/lib/daemon-rebuild.mjs", "we:scripts/conveyor/soak/breaks/__tests__/smoke-expired-gh-token.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a check:standards rule or test that fails when any soak break asserts on a reason or alert ki… (from web-everything/web-everything#3949 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/smoke-expired-gh-token.mjs:139` — Add a check:standards rule or test that fails when any soak break asserts on a reason or alert kind a recent change has made non-default (for example, require every break that references 'smoke-harness-broken' to pin the knob). Alternatively, make the soak runner execute every break's fixPresent=false (RED) mode in CI so a break that cannot fail is caught.
2. `we:scripts/lib/daemon-rebuild.mjs:2317` — Follow-up: also compare normalized failure detail, or surface the candidate's and control's details in the adopted-not-worse alert for operator review. Add a test where the candidate and control fail the same check name with different details.
3. `we:scripts/lib/daemon-rebuild.mjs:2331` — Add a test that fails when a candidate and control fail the same check name with different detail and the candidate is adopted. Better, also compare details, or limit adoption to checks matching a known harness-failure signature. Keep the opt-out default-off for non-pinned overlays.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3949@7e818b73d9b0177d2c746dfa9c165a02cff6f3d1

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
