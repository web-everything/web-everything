---
bornAs: xbtgn9q
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-10-06"
preparedAgainstSha: "d4cf949b2edde575118632d9cccc1f6e08d73b4b"
tags: []
---

# Prevention — Add a table-driven test of citation phrasings to the content-lint test file, including , and, and, & an… (from chalbert/web-everything#3299 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards-rules.mjs:1038` — Add a table-driven test of citation phrasings to the content-lint test file, including `, and`, `and`, `&` and ranges. A property test over generated separator forms would also catch it.
2. `we:scripts/check-standards-rules.mjs:1065` — Extend the deterministic pending-lane exemption test with bare, inline-code, and Markdown-link references, plus unmarked controls that must still warn.
3. `we:scripts/check-backlog-item.mjs:93` — A simple CI smoke test executing `we:scripts/check-backlog-item.mjs` against a mock or known-good item to ensure it does not crash from undeclared variables.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3299@9857a8c31ece758908e5d730abe50c0e0c19c8cf

## Progress

- Premise check (2026-10-06): `git log --grep=4781` finds only the drain's JIT-numbering commit, not a delivery. Not already done.
- Citation drift: item 1 cites `we:scripts/check-standards-rules.mjs:1038`, now `MUST_CITE_RE` at `we:scripts/check-standards-rules.mjs:1090` and its splitter at `:1106`; item 2's `BACKLOG_PROSE_REF_RE` is at `:1118`; item 3's guard lives in `we:scripts/__tests__/check-backlog-item.test.mjs` (CLI wiring tests). Scope corrected: dropped the nonexistent `we:scripts/__tests__/check-standards-rules.test.mjs` for the real `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, and dropped the two `check-backlog-item` files (item 3 needs no change).
- Item 3 is already delivered: `we:scripts/__tests__/check-backlog-item.test.mjs:86` runs the real CLI against a known-good card and asserts exit 0 (no undeclared-variable crash). Verified, not re-added.
- Probe against current `main` found a real bug item 1 predicted: `Musts 1, 2, and 3` cites only 1 and 2, because `(?:,|and|&)` in `MUST_CITE_RE` cannot match the two-token `, and` separator. Fixing it is in the MVP.

## Design

Two existing pure functions in `we:scripts/check-standards-rules.mjs` get table-driven coverage in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` (next to the `findMustWithoutDoneWhen` and `findDanglingBacklogRefs` describes at `:679` and `:699`).

1. `findMustWithoutDoneWhen`: a `it.each` table of Done-when phrasings against a 4-Must card, each row giving the expected uncited Musts: `Musts 1, 2, and 3`, `Musts 1 and 2`, `Musts 1 & 2`, `Musts 1,2`, `Musts 1, 3 & 4`, en-dash range `Must 1\u20133`, spaced range `Musts 1 - 2, 4`, `Must 2 and Must 4`, upper-case `MUSTS 1 AND 2`. The `, and` row fails today. Fix: allow an optional comma before `and` in both the capture group of `MUST_CITE_RE` (`:1090`) and the split regex (`:1106`), i.e. `(?:,\s*and|,|and|&)`, longest alternative first.
2. `findDanglingBacklogRefs`: rows pinning the `(pending-lane)` exemption for bare, inline-code (marker inside and outside the backticks), and Markdown-link references, plus unmarked controls and a marker-on-one-ref-only row that must still report the other id. Expected values are the current behaviour measured by probe: marker right after a bare ref exempts; marker after a closing backtick or `)` does not; marker inside the backticks does.

## MVP

**Must (MVP):**
1. Fix `MUST_CITE_RE` and its splitter so `, and` is a valid list separator.
2. Table-driven test of Must-citation phrasings (rows above), including `, and`, `and`, `&`, ranges.
3. Table-driven test of the `(pending-lane)` exemption for bare, inline-code and Markdown-link refs, with unmarked controls that still report.

**Out:** property/generative separator test; changing which marker placements count as exempt (see Follow-ups); item 3's smoke test (already delivered, see Progress).

## Test plan

- Must-citation table, row `Musts 1, 2, and 3` asserts uncited is `[4]`; RED before the fix (returns `[3,4]`). Remaining rows assert the measured results and pass today (preservation, mutation proof: revert the regex fix so the `, and` row goes red).
- Pending-lane table: bare ref + marker returns `[]`; unmarked bare, inline-code and link refs each return the id (control, would fail if the exemption were over-broad); marker after a closing backtick or link returns the id (pins the current boundary); marker on one of two refs leaves the other reported. Preservation case: GREEN today, mutation proof is loosening the exemption to match anywhere so a control row goes red.
- Mutation check: temporarily revert the regex fix and confirm the `, and` row goes red; loosen the exemption to match anywhere and confirm a control row goes red.

## Proof plan

Run `npx vitest run check-standards-rules-content-lint` red (expected failure: the `Musts 1, 2, and 3` row, got `[3,4]` want `[4]`, on unfixed regex) then green after the fix, and show both outputs. Run a CLI probe of `findMustWithoutDoneWhen` on a real-shaped card citing `Musts 1, 2, and 3` before/after, then `npm run check:standards`.

## Follow-ups

- Decide whether `(pending-lane)` after a closing backtick or Markdown link should exempt (today it does not, so authors who write it that way still get a warning). Behaviour call; file as a separate decision item.
- Generative property test over separator forms.

## Done when

1. **Executable** — `npx vitest run check-standards-rules-content-lint` fails before this item lands (the `Musts 1, 2, and 3` row, the only RED row; Must 3 is characterisation coverage, verified by mutation) and passes after; Musts 2 and 3 each map to a table in that file.
