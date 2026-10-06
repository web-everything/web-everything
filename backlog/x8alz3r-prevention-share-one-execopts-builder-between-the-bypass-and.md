---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/heavy-queue-projection.mjs", "we:scripts/readiness/__tests__/heavy-admission-fast-lane.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Share one execOpts builder between the bypass and admitted paths, and add a test asserting the ti… (from web-everything/web-everything#4147 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/heavy-admission.mjs:1237` — Share one `execOpts` builder between the bypass and admitted paths, and add a test asserting the timeout under bypass='off'.
2. `we:scripts/readiness/heavy-admission.mjs:1257` — An integration test that runs a real `sh -c 'sleep 30 & wait'` under a short timeout and asserts no surviving child.
3. `we:scripts/readiness/heavy-queue-projection.mjs:131` — Add a classifier test for a multi-segment chain that pins whichever semantics (max or sum) is intended.
4. `we:scripts/readiness/heavy-admission.mjs:1256` — Add an integration test that spawns a real descendant under a short timeout and asserts no survivors. Alternatively, run `files` runs in a detached process group and kill the group on timeout.
5. `we:scripts/readiness/__tests__/heavy-admission-fast-lane.test.mjs:246` — Add a deterministic assertion that a files run with env={} passes timeout=480000 to exec, alongside the existing override assertion.
6. `we:scripts/readiness/heavy-admission.mjs:1256` — Add a classifier unit test that lists every `we:package.json` script wrapped in `we:scripts/readiness/heavy-admission.mjs run` and every `admittedArgv` vitest caller (with representative file args), and asserts which of them may get the fast-run timeout. Alternatively, apply the timeout only when no `--config` or `-c` flag is present, or when the config is the default unit config, and pin that in the existing fast-lane test.
7. `we:scripts/readiness/heavy-admission.mjs:1245` — Derive the exec timeout from the remaining budget (cap minus `admission.waitedMs`), and add a test that injects a non-zero wait and asserts the exec timeout shrinks. Add a test that the bypass branch either applies the timeout or documents why it doesn't.
8. `we:scripts/readiness/heavy-queue-projection.mjs:124` — Add a unit test for `resolveFastRunTimeoutMs({})` (default, and below 10 minutes), `resolveFastRunTimeoutMs({X:'500'})` (falls back to the default) and `resolveFastRunTimeoutMs({X:'abc'})`. Do the same for `resolveFastMaxFiles` with '0', 'abc' and '2.7'.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4147@5d209380baf48b4ec702c60c039e49edec6c7258

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
