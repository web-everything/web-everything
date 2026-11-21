---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/backlog-placement-trial.mjs", "we:scripts/conveyor/__tests__/pr-live-owner-watch.test.mjs", "we:scripts/__tests__/backlog-placement-trial.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a runTrial assertion with a slugged filename. More broadly, a review-lens rule that every com… (from web-everything/web-everything#7269 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/backlog-placement-trial.mjs:96` — Add a runTrial assertion with a slugged filename. More broadly, a review-lens rule that every comment citing a rule or decision ID (like R971) needs a test naming it.
2. `we:scripts/conveyor/__tests__/pr-live-owner-watch.test.mjs:356` — A write-gate that flags changed files not listed under the PR body's Files section.
3. `we:scripts/backlog-placement-trial.mjs:93` — Add a runTrial test with a slug-bearing filename and a non-numeric filename, asserting `/^\d+$/` or a redacted id. Better, add a write-gate or lint that rejects non-numeric ids in reports/data/*.json.
4. `we:scripts/backlog-placement-trial.mjs:36` — Enable an unused-local-function lint gate for .mjs scripts; this guard must be filed as follow-up work.
5. `we:scripts/__tests__/backlog-placement-trial.test.mjs:34` — Add table-driven boundary tests to the regular test gate and require threshold/cap mutants to fail; this guard must be filed.
6. `we:scripts/__tests__/backlog-placement-trial.test.mjs:46` — Gate the CLI with an integration test that checks input bytes for ordinary and colliding output paths; the disclosed output-restriction follow-up should capture this test, but no such gate is shown.
7. `we:scripts/backlog-placement-trial.mjs:105` — Gate CLI changes on an integration test that asserts input bytes remain unchanged for default output, explicit output, and input/output aliases, with aliases rejected before writing.
8. `we:scripts/backlog-placement-trial.mjs:32` — Add a mandatory parameterized parser test covering missing delimiters, malformed YAML, and valid YAML, asserting the unreadable-frontmatter result for invalid cases.
9. `we:scripts/backlog-placement-trial.mjs:57` — Gate the placement parser with table-driven tests for exact supported destinations, explanatory suffixes containing other destinations, and ambiguous or unsupported values.
10. `we:scripts/__tests__/backlog-placement-trial.test.mjs:34` — Add the named boundary and failure-path tests to the required suite, and a deterministic acceptance-evidence check requiring named test results and red/green/live-run receipts.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7269@2b7498e41766b7aa5c56f2a28ddfbe956db9b8b3

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
