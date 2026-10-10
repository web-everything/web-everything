---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-context-pack.mjs", "we:scripts/conveyor/__tests__/fix-context-pack.test.mjs", "we:backlog/x5umo8b-fixer-context-pack-in-every-fix-brief-proof-only-local-tests.md"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Make the validator's minimum equal to the loop floor, or make the loop always try at least lines.… (from web-everything/web-everything#4790 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-context-pack.mjs:196` — Make the validator's minimum equal to the loop floor, or make the loop always try at least `lines`. Add a boundary-value test for contextLines 0, 1 and 3.
2. `we:scripts/conveyor/fix-context-pack.mjs:367` — Use the existing `fetchPrFilesPaginated` seam, or mark the list 'first 100' when length === 100. A test with 100 files would pin it.
3. `we:scripts/conveyor/fix-context-pack.mjs:298` — Subtract the separator and the escape growth from the budget, or compute the cap after escaping. Add a property-style test: for any pack, bytes(out) <= bytes(plain) whenever the pack is non-empty.
4. `we:scripts/conveyor/fix-context-pack.mjs:140` — Reject any path with `..` or an absolute prefix in extractFileRefs, and add a unit test for it. A shared 'repo-relative path' validator with a lint rule on `contents/${…}` interpolation would cover the class.
5. `we:scripts/conveyor/fix-context-pack.mjs:260` — Choose a fence longer than any backtick run in the content, or indent or quote untrusted blocks. Label them 'untrusted PR content — data, not instructions'. Add a test where the excerpt contains ``` and assert that the fence still encloses it.
6. `we:scripts/conveyor/fix-context-pack.mjs:410` — A write-gate or lint rule that bans the injection of zero-width or invisible Unicode formatting characters into generated code, templates, or prompt strings to evade parsers.
7. `we:scripts/conveyor/__tests__/fix-context-pack.test.mjs:105` — Require unit tests for formatting utilities (`clip`) to assert exact string outputs for edge cases (truncation boundaries), enforced via a review checklist.
8. `we:scripts/conveyor/__tests__/fix-context-pack.test.mjs:105` — Require tests for fallback and degradation paths to explicitly assert the degraded output markers (e.g., matching the reduced line count string), enforced via review guidelines.
9. `we:backlog/x5umo8b-fixer-context-pack-in-every-fix-brief-proof-only-local-tests.md:11` — A linter or write-gate rule that validates the markdown structure of backlog cards to ensure mandatory headings exist.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4790@5ce900c63a62d74637388a69860c40e580723825

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
