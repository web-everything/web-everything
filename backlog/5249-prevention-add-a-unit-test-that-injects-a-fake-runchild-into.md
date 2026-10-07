---
bornAs: xt9x05s
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a unit test that injects a fake runChild into checkDispatchDryRun and asserts the child env c… (from web-everything/web-everything#4206 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-live-smoke.mjs:571` — Add a unit test that injects a fake runChild into checkDispatchDryRun and asserts the child env carries an isolated WE_FIX_LOOP_LEDGER. A broader guard is a smoke-harness rule that any stubbed dispatch must run with isolated state paths.
2. `we:scripts/lib/daemon-live-smoke.mjs:575` — Add a deterministic smoke test that captures runChild's environment and asserts WE_FIX_LOOP_LEDGER overrides an explicitly configured live ledger path; removing the override must fail that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4206@8811cd7fbeefe62698d4b536830c1dcc168e4b71

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
