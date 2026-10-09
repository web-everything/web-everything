---
bornAs: x4s0rw0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/completion-store.mjs", "we:scripts/operations/__tests__/completion-store.test.mjs"]
dateOpened: "2026-09-29"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2947's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/completion-store.mjs:215` — A `check:standards` lint rule that parses absolute guarantees ('never', 'must never') in comments and requires an explicit `// tested by: <test-name>` citation to ensure test coverage exists for the claim.
2. `we:scripts/operations/__tests__/completion-store.test.mjs:45` — A review lens or lint rule that cross-checks 'ANY' or 'ALL' claims in test comments against the actual inputs provided in the test block, flagging when a test asserts a universal property but only provides a single example-based input.
3. `we:scripts/operations/completion-store.mjs:213` — A review lens that flags absolute guarantees in code comments ('never', 'always') and requires them to either cite their defending test or explicitly state they are intentionally unguarded.
4. `we:scripts/operations/__tests__/completion-store.test.mjs:44` — A test-review checklist item requiring that when a comment claims a universal property ('ANY call'), the accompanying test explicitly asserts the property across both success and failure example cases, rather than just one.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2947@4fbc20ca7ced68c23c28857df62a3ac6f25782ec

## Ruling (operator, 2026-10-09 ~13:25 ET)

The open choice from the prepare run (lint that requires a test citation for every absolute claim, vs a review
lens) is ruled **(b) review lens**: reviewers flag absolute guarantees in comments ("never", "always", "ANY")
and the author either cites the defending test or marks the claim `intentionally unguarded: <reason>`. No
`check:standards` lint on the bare words (too noisy: the words are common in plain prose, and a forced citation
invites rubber-stamping). Deciding whether prose is a real guarantee is judgment, so it lives in review. A narrow
lint on an explicit marker may follow later only if the lens misses cases. Same ruling applies to #4411.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
