---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:bun-trial/scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/__tests__/daemon-overlay-audit-gate.test.mjs", "we:scripts/lib/overlay-audit-evidence.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/__tests__/daemon-overlay-audit-check.test.mjs", "we:scripts/lib/__tests__/overlay-audit-evidence.test.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Share a single test helper that builds the audit-off env plus prefs file, so fixtures cannot omit… (from web-everything/web-everything#7369 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:bun-trial/scripts/__tests__/daemon-overlay.test.mjs:80` — Share a single test helper that builds the audit-off env plus prefs file, so fixtures cannot omit half of it.
2. `we:scripts/__tests__/daemon-overlay-audit-gate.test.mjs:1` — Add a lint or standards rule that tests touching cascadePolicy must set WE_PLATFORM_PREFERENCES_FILE, and fix the doc claim.
3. `we:scripts/lib/overlay-audit-evidence.mjs:14` — A test that asserts the git argv set contains no fetch, pull, or remote-update call.
4. `we:scripts/daemon-overlay.mjs:82` — Add a doc-claim lint, or a review-lens item, that flags header comments naming a flag together with a behaviour claim when the diff touches that flag's code path.
5. `we:scripts/__tests__/daemon-overlay-audit-gate.test.mjs:1` — Add a test-plan checklist item requiring every mode or enum value of a new policy setting to have a named test. Optionally add a mutation spot-check of the gate's return lines.
6. `we:scripts/daemon-overlay.mjs:649` — File a backlog card to require an operator-attested override, for example a waiver-ledger entry or an operator-login check, and to surface `unaudited-override` events in the standing overlay inventory.
7. `we:scripts/__tests__/daemon-overlay-audit-check.test.mjs:55` — Add a deterministic subprocess-spy regression test asserting GIT_NO_LAZY_FETCH=1 for both inventory Git paths and rejecting fetch invocations.
8. `we:scripts/__tests__/daemon-overlay-audit-gate.test.mjs:121` — Add a CI gate that runs every suite advertised as dual-runner under both node:test and Vitest.
9. `we:bun-trial/scripts/__tests__/daemon-overlay.test.mjs:80` — Include the Bun overlay CLI suite in the required admission-policy regression gate with default operator settings.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7369@995d1f9d04d303aebedf875d32ad57e249f372a0

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
