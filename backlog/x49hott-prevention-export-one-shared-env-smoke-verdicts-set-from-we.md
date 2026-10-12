---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-version-runtime.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-version-runtime.test.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Export one shared ENV_SMOKE_VERDICTS set from we:scripts/lib/daemon-live-smoke.mjs and import it… (from web-everything/web-everything#5045 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-version-runtime.mjs:28` — Export one shared `ENV_SMOKE_VERDICTS` set from `we:scripts/lib/daemon-live-smoke.mjs` and import it in `we:scripts/lib/daemon-version-runtime.mjs`. Add a test that iterates every verdict `runLiveSmokeWithRetry` can return and asserts each consumer handles it.
2. `we:scripts/lib/daemon-live-smoke.mjs:1030` — Add a test with the probe sequence unavailable, ok, ok and a persistent tree failure, and assert the intended verdict explicitly.
3. `we:scripts/lib/daemon-live-smoke.mjs:1030` — Add a mixed-sequence probe test, and decide `env-unavailable` from the final attempt's probe result only. A lint rule can't catch this class; it is a test-matrix gap.
4. `we:scripts/lib/daemon-live-smoke.mjs:1024` — Add a deterministic regression test with an initial 502 followed by successful probes and persistent tree failure, asserting the final verdict is code; use current probe evidence for the final classification.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5045@f23d7b7b6e6f54378ad8891c19a314c3e7522fe4

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
