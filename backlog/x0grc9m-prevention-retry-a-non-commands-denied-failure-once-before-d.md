---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/__tests__/daemon-rebuild-smoke.test.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Retry a non-commands-denied failure once before dropping, or drop only on commands-denied. Add a… (from web-everything/web-everything#4488 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/smoke.mjs:91` — Retry a non-`commands-denied` failure once before dropping, or drop only on `commands-denied`. Add a test that `launch-failed` with an env-shaped detail does not remove the overlay.
2. `we:scripts/lib/daemon-rebuild/smoke.mjs:131` — When the module is unavailable and `dispatchSmokeSuspects` cannot run, hold with `dispatch-smoke-unavailable`. Add a test that injects a failing import.
3. `we:scripts/lib/__tests__/daemon-rebuild-smoke.test.mjs:1` — Add one test per adopt path that mutates away its dispatch gate, or a lint requiring each `finalize(` call site in we:scripts/lib/daemon-rebuild/smoke.mjs to be preceded by a dispatch check.
4. `we:scripts/lib/daemon-rebuild/smoke.mjs:340` — Run `redactDetail` once, when `why` is built, so every downstream sink gets the redacted string; add a unit test with a secret-shaped detail.
5. `we:scripts/lib/daemon-rebuild/smoke.mjs:125` — Treat 'smoke required (suspects non-empty) but runner unavailable' as a failed dispatch smoke and hold; add a test with the module load injected to fail.
6. `we:scripts/lib/daemon-load-overlay.mjs:296` — Narrow the denial match to the exact approval-prompt wording, or retry once before a destructive drop; add `judgeDispatchSmoke` and `transcriptDenials` tests with benign 'permission' strings.
7. `we:scripts/lib/daemon-load-overlay.mjs:486` — Add a deterministic integration test composing runDaemonLoadOverlay with rebuildClone and an injected worker launcher, asserting exactly one launch for a passing new overlay; consolidate candidate gating in rebuild while preserving any necessary post-adoption check.
8. `we:scripts/lib/daemon-rebuild/smoke.mjs:329` — Add a deterministic regression test with one healthy and one broken dispatch overlay; retain ambiguous suspects unless an isolated smoke establishes which overlay should be removed.
9. `we:scripts/lib/daemon-rebuild/smoke.mjs:210` — Add an injectable module-loader failure test that deterministically requires a hold, keeping unavailable wiring distinct from an explicit off setting.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4488@b9996ee9f2acab3c400a925c2d6318ae96ffb1c9

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
