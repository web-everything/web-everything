---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-audit-io.mjs", "we:backlog/8705-recover-unreadable-codex-audit-lineages-with-preserved-evidence.md", "we:scripts/operations/codex-audit.mjs", "we:scripts/operations/audit-nonconvergence.mjs", "we:scripts/operations/__tests__/codex-audit-io.test.mjs", "we:scripts/operations/__tests__/codex-audit.test.mjs", "we:scripts/operations/__tests__/audit-nonconvergence.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Record reason in the queue record and include it in the dedupe key, or skip the queue write for u… (from web-everything/web-everything#7415 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/codex-audit-io.mjs:132` — Record `reason` in the queue record and include it in the dedupe key, or skip the queue write for unreadable-lineage. Add a test that interleaves both reasons for one ref. A lint is not practical here, so the test is the guard.
2. `we:backlog/8705-recover-unreadable-codex-audit-lineages-with-preserved-evidence.md:1` — Have the backlog-card write-gate require Risks and Test plan sections on cards that carry an Edge cases list.
3. `we:scripts/operations/codex-audit.mjs:244` — Add a test for the unresolved-ref + unreadable-ledger + NOT WEAKENED case that states the intended outcome. If fail-open is intended, document it where the guarantee is stated.
4. `we:scripts/operations/audit-nonconvergence.mjs:43` — Add a readable-lineage test with two records for the same head asserting `rounds` and `streak`. A mutation-test gate over the new module would also catch this class.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5473, finding 6 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7415@0d5912adadb2757cf6f9d1d0a6f9883fafd76a4e

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
