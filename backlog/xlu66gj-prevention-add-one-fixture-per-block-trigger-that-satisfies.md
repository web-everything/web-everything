---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs", "we:scripts/operations/ruled-weakened-store.mjs", "we:scripts/operations/rewaive-plan.mjs", "we:scripts/operations/__tests__/ruled-weakened-store.test.mjs", "we:scripts/operations/__tests__/rewaive-plan.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add one fixture per block trigger that satisfies only that trigger, backed by a diff-scoped mutat… (from web-everything/web-everything#7493 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs:49` — Add one fixture per block trigger that satisfies only that trigger, backed by a diff-scoped mutation check on fail-closed predicates.
2. `we:scripts/operations/ruled-weakened-store.mjs` — Add a fixture whose only block trigger is the escaped ref.
3. `we:scripts/operations/rewaive-plan.mjs:136` — Add a runCli test without `--json` asserting the malformed-lines text.
4. `we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs` — File a card to bring the waiver-log writer into the repo with a test that it rejects non-JSON input.
5. `we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs` — Add a fixture with a WEAKENED head record and one unrelated bad line, asserting state `request` and the `malformed` list.
6. `we:scripts/operations/ruled-weakened-store.mjs:61` — File the reinforce-later card: block when damaged text has no complete ref, with truncation fixtures at each field boundary.
7. `we:scripts/operations/rewaive-plan.mjs:83` — Pass start line and count to warnOther as structured arguments and add a split-record fixture.
8. `we:scripts/operations/ruled-weakened-store.mjs:60` — File a backlog item for tests that isolate each condition: a malformed WITHDRAWN line and a revok line that name no ref or another ref, and an escaped-slash ref with no revocation word. Longer term, add a mutation check for fail-closed predicates in waiver code.
9. `we:scripts/operations/rewaive-plan.mjs:136` — File a backlog item: add a runCli text-mode assertion and a request-state fixture with a malformed line. A review lens should require a test for each output surface a safety notice is promised on.
10. `we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs` — File a backlog item: move the waiver writers into the repo, or add a handoff __tests__ case that feeds each writer an invalid line and asserts nothing is appended.
11. `we:scripts/operations/ruled-weakened-store.mjs:53` — File a backlog item: under relaxUnattributed, apply the ref-text check to named damaged lines too (or normalise origin/ and refs/heads/), with a table test of ref spellings.
12. `we:scripts/operations/ruled-weakened-store.mjs:35` — Add a deterministic regression matrix covering omitted, false, and true relaxUnattributed values.
13. `we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs:45` — Add the request-producing regression to the existing planner test suite.
14. `(no file cited)` — Add a deterministic writer rejection test in the repository that owns those scripts and reference its exact file and case in Acceptance.
15. `we:scripts/operations/ruled-weakened-store.mjs` — Add a deterministic parameterized test covering bare and refs/heads-qualified scope names against equivalent malformed ref representations.
16. `we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs:43` — Gate the regression suite on a fixture with an eligible carry that asserts state `request`, its findings, and the malformed line number.
17. `(no file cited)` — Add a deterministic test for each writer asserting nonzero exit and unchanged log contents after non-JSON input.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7493@6682f9ce6621cde11d8096360122a44abdae409e

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
