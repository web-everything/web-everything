---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/canonical-audit-gate.mjs", "we:scripts/operations/__tests__/canonical-audit-main-merge-carry.test.mjs", "we:scripts/lib/main-merge-carry.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/canonical-audit-gate.test.mjs", "we:scripts/lib/__tests__/main-merge-carry.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Route the intermediate-head veto through findAudit/canonicalAuditEvidence for each chain head (la… (from web-everything/web-everything#7279 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/canonical-audit-gate.mjs:160` — Route the intermediate-head veto through findAudit/canonicalAuditEvidence for each chain head (latest verdict per base), and add a test where an intermediate's WEAKENED is superseded. A review lens would do; no deterministic gate fits.
2. `we:scripts/operations/canonical-audit-gate.mjs:175` — Gate the message on `evidence.reason === 'weakened'`, or on a carry-eligible record that is also base-covered. Add a test for a carry-eligible audit with an uncovered base that expects the standard re-audit message.
3. `we:scripts/operations/__tests__/canonical-audit-main-merge-carry.test.mjs:1` — Add one real-git fixture where main edits lines above the lane's hunk, so only line offsets shift, and assert the carry is refused.
4. `we:scripts/lib/main-merge-carry.mjs:9` — Add a graft fixture and a commit-graph fixture to the main-merge-carry test file. Longer term, add a check:standards rule that every GIT_* env scrub or -c override in scripts/lib has a named test.
5. `we:scripts/operations/open-pr-io.mjs:264` — Add a test in we:open-pr-audit-gate.test.mjs with a carried audit and a nonexistent --body-file, asserting reason 'audit-carry-unrecorded' and that spawn is never called.
6. `we:scripts/operations/open-pr-io.mjs:262` — Add a deterministic integration test named 'runs CI on the carried merge head' that asserts the tested checkout SHA equals carried.to; this guard requires a future backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7279@baa2c4b13fed87ca60add7803cd2aae37b1dc843

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
