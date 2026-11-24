---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/remote-target.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:docs/agent/testing/remote-targets.md", "we:scripts/readiness/__tests__/remote-target.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a remote-target test that routes the probe through defaultExec's real option merge and assert… (from web-everything/web-everything#7427 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/remote-target.mjs:16` — Add a remote-target test that routes the probe through defaultExec's real option merge and asserts it includes connectionOptions(). Alternatively, have the probe call `[...connectionOptions(), ...probeOptions]` so it can't drift.
2. `we:scripts/readiness/heavy-admission.mjs:1328` — Test case: custom hosts, all unhealthy, ineligible argv. Assert no probe and no 'no-healthy-remote' fallback record. Then gate the probe on `decideRemote(...).remote` or on needsGit.
3. `we:docs/agent/testing/remote-targets.md:5` — Add a cascade test over all remote leaves, including hosts, that checks tool overrides are ignored on a shared pool. Generate it from ADMISSION_VALID so new leaves are covered automatically.
4. `we:scripts/readiness/__tests__/remote-target.test.mjs:87` — Add a table-driven settings-cascade test that iterates every `ADMISSION_VALID` leaf across the platform, tool and env layers with shared-pool and private-pool variants. A new leaf then gets cascade coverage automatically.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7427@721dd431cd0840556d6ecbeb7779a23388c480d7

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
