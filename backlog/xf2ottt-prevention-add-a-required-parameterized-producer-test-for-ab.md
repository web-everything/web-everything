---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/lane-verify-shared.test.mjs", "we:scripts/lib/verify-shared-marker.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/settings-registry-metadata.d/settings/verify.json", "we:scripts/__tests__/pr-land-finish-guard.test.mjs", "we:scripts/lib/__tests__/verify-shared-marker.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a required parameterized producer test for absent/0/1 switch values, asserting successful pub… (from web-everything/web-everything#7516 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/lane-verify-shared.test.mjs:87` — Add a required parameterized producer test for absent/0/1 switch values, asserting successful publication and identical policy keys.
2. `we:scripts/lib/verify-shared-marker.mjs:11` — Add a required verifier integration test that reuses a local green and asserts no shared record is created or modified.
3. `we:scripts/verify-lane.mjs:1469` — Add a source-order test, like the entry-point identity test already in the suite. It would assert that `maybePublishSharedGreen({ status, treeHash, revertRed })` appears after `writeMarker` and not before the reuse early-exit. Better, make `revertRed` a required argument that throws when absent, so a default cannot satisfy the check.
4. `we:scripts/lib/settings-registry-metadata.d/settings/verify.json:10` — Add a deterministic parameterized producer test asserting successful publication under unset, disabled, and enabled reuse settings; this guard remains to be captured.
5. `we:scripts/lib/verify-shared-marker.mjs:11` — Add a deterministic CLI regression test with a reusable local marker and empty shared store, asserting the shared store remains empty; this guard remains to be captured.
6. `we:scripts/lib/verify-shared-marker.mjs:121` — Reject nonregular entries before opening, use a nonblocking open to handle replacement races, and add a subprocess test asserting FIFO evidence promptly returns corrupt.
7. `we:scripts/__tests__/pr-land-finish-guard.test.mjs:239` — Add a parameterized reader contract test covering absent, explicit zero, and explicit one settings, asserting the returned marker against conflicting local/shared evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7516@6ff4058671143fc957e5fb1e44a78072c82c3698

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
