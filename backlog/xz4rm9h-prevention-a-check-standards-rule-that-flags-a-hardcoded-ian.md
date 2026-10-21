---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/file-item-io.mjs", "we:scripts/operations/file-item.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/file-item-io.test.mjs", "we:scripts/operations/__tests__/file-item.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — A check:standards rule that flags a hardcoded IANA zone passed to localDateString in scripts/oper… (from web-everything/web-everything#5242 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/file-item-io.mjs:36` — A check:standards rule that flags a hardcoded IANA zone passed to `localDateString` in scripts/operations/*, plus a test that file-item and scaffold stamp the same date under a pinned BACKLOG_TZ.
2. `we:scripts/operations/file-item.mjs:173` — Add a file-item test that files an ordinary card with a throwing `readTip` and asserts success. This is a unit-test gate, not a lint rule.
3. `we:scripts/operations/dispatch-lane-io.mjs:1803` — A standards-gate or lint rule that fails when a privilege or route decision reads a frontmatter flag (`operatorTask`) that has no verified-source helper. Until that exists, the route override should be removed from this PR or the operator should sign off on it.
4. `we:scripts/operations/file-item.mjs:83` — Land the `preparedBy: "operator-filing"` marker and the dispatch-plan check that counts it only while the switch is on (xqqmw6g), with a dispatch-plan test that disables the switch after stamping.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5242@e1ad46ac11206fd1a5b410eacc8eb3915395bfe5

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
