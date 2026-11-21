---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/backlog-placement-trial.mjs", "we:scripts/__tests__/backlog-placement-trial.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add table-driven negative tests for the explicit-placement parser (empty value, a value on the ne… (from web-everything/web-everything#7269 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/backlog-placement-trial.mjs:62` — Add table-driven negative tests for the explicit-placement parser (empty value, a value on the next line, the word "we" in prose). When the parser is rewritten, anchor the value to the same line (`[ \t]*`) and require the whole value to match an allow-list.
2. `we:scripts/backlog-placement-trial.mjs:93` — Run a mutation or coverage threshold on new scripts, or add a lint rule requiring a test for each catch block that assigns a result.
3. `we:scripts/backlog-placement-trial.mjs:96` — Add a runTrial test with non-numeric and slug-bearing filenames that asserts report ids match /^\d+$/. Better, make the code emit the id only when it matches /^\d+/ and otherwise use a counter.
4. `(no file cited)` — Add a deterministic acceptance-evidence gate requiring retained before/after named test results and a live-run receipt linked to the generated report.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7269@06f4cc94967e48f77344990b15a66377a9744879

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
