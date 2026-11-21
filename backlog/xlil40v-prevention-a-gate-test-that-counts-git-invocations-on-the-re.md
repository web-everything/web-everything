---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/canonical-audit-gate.mjs", "we:scripts/lib/main-merge-carry.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/canonical-audit-gate.test.mjs", "we:scripts/lib/__tests__/main-merge-carry.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — A gate test that counts git invocations on the refusal path with N unrelated audit records and as… (from web-everything/web-everything#7279 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/canonical-audit-gate.mjs:178` — A gate test that counts git invocations on the refusal path with N unrelated audit records and asserts it does not grow with N. Also cheap-check-first ordering (test the fingerprint before running git).
2. `we:scripts/operations/canonical-audit-gate.mjs:178` — Derive the hint from canonicalAuditEvidence's own reason or record instead of a separate scan. Add a negative test with a prior-question or uncovered-base record that expects the normal re-audit message.
3. `we:scripts/lib/main-merge-carry.mjs:9` — A graft-planting negative test next to the replace-ref test. A lint is not warranted.
4. `we:scripts/operations/canonical-audit-gate.mjs:178` — Limit the eligibility probe to heads already considered: the evidence head and the waiver entries for this ref. Alternatively cap the number of probes, and add a test that counts git invocations on the refusal path with N unrelated records.
5. `we:scripts/lib/main-merge-carry.mjs:49` — Add the two fixtures above. As a lint, require each hardening env var or flag introduced in a git-reading gate to appear in a test fixture that plants the corresponding attack.
6. `we:scripts/operations/open-pr-io.mjs:253` — Share one 'body file consumed by pr-land' resolver between withBypassInBody and withCarryNoteInBody, with a test for duplicate flags that asserts both notes reach the file pr-land reads.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7279@b247c9b96a074980501bc0e42097252d64288692

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
