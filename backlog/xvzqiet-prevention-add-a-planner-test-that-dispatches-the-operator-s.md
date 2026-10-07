---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a planner test that dispatches the operator-send-back fix and then re-plans with no recorded… (from web-everything/web-everything#4198 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1930` — Add a planner test that dispatches the operator-send-back fix and then re-plans with no recorded round. Assert the outcome is cap-bounded or refused, to pin what 'once' means.
2. `we:scripts/conveyor/reconcile-core.mjs:1930` — Add a test for a send-back on a red PR at the cap. State whether it should park or fall through to ci-heal.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:296` — Enable ESLint `no-dupe-keys` and an indentation rule over scripts/conveyor.
4. `we:scripts/conveyor/reconcile-core.mjs:1921` — Review lens: a new block must not be inserted inside an existing leading-comment-to-code pair.
5. `we:scripts/conveyor/reconcile-core.mjs:1930` — Add deterministic planner tests for exhausted versus available operator grants and parameterize consumption over re-arm and advisory markers; verify that removing each corresponding guard makes its named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4198@efa475a9f221f26905a6b24fd3aa5dcbb7b80037

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
