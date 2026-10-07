---
bornAs: xq3823h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/lane-git-hardening.mjs", "we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/lane-pool.mjs", "we:scripts/lib/__tests__/lane-git-hardening.test.mjs", "we:scripts/conveyor/__tests__/await-verify-pass.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Scope the pins to lane-local config (for example, set them only when the repo-local config define… (from web-everything/web-everything#4151 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/lane-git-hardening.mjs:18` — Scope the pins to lane-local config (for example, set them only when the repo-local config defines the key). Alternatively, add a test that runs lane-pool and verify-lane git calls under a global `core.sshCommand`.
2. `we:scripts/conveyor/await-verify-pass.mjs:205` — Make the clear conditional on the stored record's `requestedAt` and `sha` still equalling the acted-on record (compare-and-delete). Add a pass test where the store record changes between resume and clear.
3. `we:scripts/lane-pool.mjs:205` — Add a check:standards rule: a script that runs git in a lane clone, either daemon-side or from the resident health watch, must route its git env through `laneGitHardeningEnv`. Also add a real-git lane-pool test with a touch-script `core.fsmonitor` that asserts it never runs on `status` or reclaim.
4. `we:scripts/conveyor/await-verify-pass.mjs` — Add a deterministic multi-tick fault-injection test that fails each persistence boundary separately and asserts bounded push calls and eventual outcome reconciliation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4151@476faef123b7bd35fe955335f18ff541f670539b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
