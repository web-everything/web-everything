---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a table-driven test that crosses finding state (unseen, bound to an earlier head, bound to th… (from web-everything/web-everything#4441 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:1580` — Add a table-driven test that crosses finding state (unseen, bound to an earlier head, bound to this head) with round state (first round, later round, open head) and lens class, and asserts the outcome for each cell. A review lens that checks every early `continue` branch against the stated guarantee would also catch it.
2. `we:scripts/lib/jury-core.mjs:1585` — Add a classifier test with two gate-lens findings that share a summary and differ only in structured `line` or quote. Pin whichever behaviour is intended: keep the second as a referral, or cover it explicitly.
3. `we:scripts/lib/jury-core.mjs:1626` — Require the changed-line evidence to be non-whitespace and non-comment, or only demote when a gate-lens seat has independently stopped re-raising the finding. File this as a follow-up backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4441@697fa7c0534e831582f15d275fe6b4acf2fedad5

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
