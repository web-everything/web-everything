---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/canonical-audit-gate.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/main-merge-carry.mjs", "we:scripts/operations/__tests__/canonical-audit-gate.test.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs", "we:scripts/lib/__tests__/main-merge-carry.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Check ancestry first with git merge-base --is-ancestor record.head fullSha, or compute origin/mai… (from web-everything/web-everything#7279 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/canonical-audit-gate.mjs:165` — Check ancestry first with `git merge-base --is-ancestor <record.head> <fullSha>`, or compute origin/main and the live fingerprint once and bound the candidate heads to a short first-parent walk from `fullSha`. A regression test with several hundred distinct dummy heads should assert a bounded number of exec calls. A `check:standards` rule against git-spawning calls inside unbounded `records.some` loops would catch the class.
2. `we:scripts/operations/open-pr-io.mjs:256` — Add a coverage gate on changed lines for scripts/operations and scripts/lib. A review checklist item should require that every `return { outcome: 'refused', reason }` branch in a diff has a test asserting that reason.
3. `we:scripts/lib/main-merge-carry.mjs:13` — Add a graft/commit-graph fixture test to we:canonical-audit-main-merge-carry.test.mjs. Longer term, add a check:standards rule that each env or config hardening key in we:scripts/lib/main-merge-carry.mjs is referenced by a test file.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7279@beca1800f9d70b985a6d009209f25bedae8b1032

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
