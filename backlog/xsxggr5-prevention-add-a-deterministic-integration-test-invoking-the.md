---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/__tests__/secret-scan.test.mjs", "we:scripts/ci/secret-scan.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a deterministic integration test invoking the trusted scanner without --allowlist, with confl… (from web-everything/web-everything#7437 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/__tests__/secret-scan.test.mjs` — Add a deterministic integration test invoking the trusted scanner without --allowlist, with conflicting trusted and PR allowlists, and assert that the PR exemption cannot suppress the finding.
2. `we:scripts/ci/secret-scan.mjs` — Add a deterministic subprocess test that rejects buffered oversized-blob reads and verifies incremental hashing with bounded chunks.
3. `we:scripts/ci/secret-scan.mjs:132` — Add a deterministic boundary regression test to the scanner suite that fails when the Git-output cap is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7437@ae531720b8cdc757c913599b9e784bb4116b85d9

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
