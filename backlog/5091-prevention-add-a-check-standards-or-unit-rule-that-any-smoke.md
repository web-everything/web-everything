---
bornAs: x13md8t
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/__tests__/daemon-rebuild-fallback.test.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a check:standards or unit rule that any smoke-failure signature matched against detail from a… (from web-everything/web-everything#3912 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild.mjs:1096` — Add a check:standards or unit rule that any smoke-failure signature matched against `detail` from a mayBeTransient:false row must be gated on the gate's own clock (`row.ms`). Also cap env-load attempts and escalate to a drop or a loud alert after N repeats.
2. `we:scripts/lib/__tests__/daemon-rebuild-fallback.test.mjs:560` — Require any new backoff/attempt-counter helper to ship a two-attempt test; mirror the existing rejectRetryDelayMs repeat-attempt test for envLoadRetryDelayMs.
3. `we:scripts/lib/daemon-live-smoke.mjs:151` — Describe every default change in the PR body, and add an upper-bound assertion on scaled budgets (for example, scaled laneAcquireMs must not exceed a fixed ceiling).
4. `we:scripts/lib/daemon-rebuild.mjs:1099` — Add a test that every signature used to classify failure rows as environmental rejects a row whose detail is `<prefix> failed: exited N: <signature text>`. Also cap `smoke-env-load` attempts so a persistently load-shaped overlay escalates to a drop or an alert instead of looping forever.
5. `we:scripts/lib/daemon-rebuild.mjs:2265` — Add a deterministic regression assertion on the plain-main and confirmation smoke arguments, then verify replacing either null with changedSince(...) fails that named test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3912@114ffe4acb274c1d7a2e2e1ee34804a5acf8108c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
