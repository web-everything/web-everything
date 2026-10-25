---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/pr-status.mjs", "we:scripts/operations/__tests__/adoption-matrix.test.mjs", "we:scripts/operations/adoption-matrix.mjs", "we:scripts/operations/__tests__/pr-status.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a renderPrTable test with a 10,000-character cell in every column that asserts each line stay… (from web-everything/web-everything#5867 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/pr-status.mjs:404` — Add a `renderPrTable` test with a 10,000-character cell in every column that asserts each line stays within 6+6+40+9+8+3 plus separators. A general rule that every prose guarantee in we:docs/agent/testing.md names a test would also catch this class.
2. `we:scripts/operations/__tests__/adoption-matrix.test.mjs:370` — Use `it.for` for tests that need context, or call `it.skipIf(!hasMkfifo)`.
3. `we:scripts/operations/pr-status.mjs:383` — Add a deterministic CLI-path regression test comparing omitted, false, and true table inputs.
4. `we:scripts/operations/adoption-matrix.mjs:9` — Add a deterministic equal-timestamp fixture with different SHAs and assert the selected record.
5. `we:scripts/operations/pr-status.mjs:403` — Add a deterministic parameterized renderer test exceeding each column’s cap and asserting exact output.
6. `we:scripts/operations/adoption-matrix.mjs:9` — Add a deterministic equal-timestamp regression test asserting that the later record's SHA wins.
7. `we:scripts/operations/pr-status.mjs:402` — Add a deterministic renderer test with oversized values in every column and assertions on the resulting column widths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5867@5e4c1c665b4767e7ca841fdfc6841327cda7a135

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
