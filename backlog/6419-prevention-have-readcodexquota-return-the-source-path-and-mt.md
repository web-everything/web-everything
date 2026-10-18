---
bornAs: xe7hczr
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/codex-usage-ledger.mjs", "we:scripts/operations/worker-wrapper.mjs", "we:scripts/lib/__tests__/codex-usage-ledger.test.mjs", "we:scripts/operations/__tests__/worker-wrapper.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Have readCodexQuota return the source path and mtime, and have withCodexUsage record a delta only… (from web-everything/web-everything#5254 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/codex-usage-ledger.mjs:47` — Have readCodexQuota return the source path and mtime, and have withCodexUsage record a delta only if the after-sample's source is newer than the run start. Add a test with a static quota stub.
2. `we:scripts/operations/worker-wrapper.mjs:335` — Add a wrapper-level test that runs withCodexUsage over a real spawnToCompletion success and a timeout. Alternatively, normalize the launch result at each call site: success gives code 0, and `killed` gives timedOut.
3. `we:scripts/lib/__tests__/codex-usage-ledger.test.mjs:177` — Add deterministic parameterized tests for the tracked-entry boundary and unsupported index entry modes, asserting unknown file-change outcomes; include them in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5254@244c3d0e8142d83985390eb19e3ccef700fbea16

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
