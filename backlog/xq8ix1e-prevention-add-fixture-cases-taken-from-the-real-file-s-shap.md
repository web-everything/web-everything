---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/approve-head.mjs", "we:scripts/lib/approval-record.mjs", "we:scripts/pr-land.mjs", "we:scripts/operations/__tests__/approve-head.test.mjs", "we:scripts/lib/__tests__/approval-record.test.mjs", "we:scripts/__tests__/pr-land.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add fixture cases taken from the real file's shapes (D-R prefix, second ruling on one line) and d… (from web-everything/web-everything#7474 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/approve-head.mjs:23` — Add fixture cases taken from the real file's shapes (D-R prefix, second ruling on one line) and decide explicitly whether each counts as a declaration; file as a backlog item.
2. `we:scripts/lib/approval-record.mjs:54` — Add a test where an App-authored run with another name and a valid external_id is refused, and assert `check_name=operator-approval` and `filter=all` in the read argv; file as a backlog item.
3. `we:scripts/lib/approval-record.mjs:49` — File a hardening card, or extend AUTH-BOUND-APPROVAL-HARDEN, to use a writer credential only the operator can reach (a dedicated approver App or an operator-signed payload verified by the reader), with a test that a run posted outside the writer is refused.
4. `we:scripts/pr-land.mjs:374` — Add a named test that calls classifyReadyOnOpen with active:true and no reader (stubbed gh or an unreadable repo) and asserts ready:false, plus one for the default resolveApp. As a class guard, use a review lens or lint requiring one test per security-relevant injectable default that omits the injection.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7474@c8387516699584a43bbd9179bfaccf75bfe2f49b

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
