---
bornAs: x4n3jex
kind: story
size: 1
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/__tests__/pr-merge-gate.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "0fd881016a3dbb1da6fc90f2cb5ef7d342af7af5"
tags: []
---

# Test-gaming detector: ignore skip/only markers inside strings and comments

Held finding 221 (2026-10-10). Live #4717: drain refused "test-gaming suspected - test-skipped: we:scripts/lib/__tests__/merge-gate-ci.test.mjs (1 skip/only marker)" but the marker was it.skip("x", ...) inside a fixture string the detector own test commits. Fix: strip string/template literals and comments (or parse) before counting skip/only markers in the drain anti-test-gaming scan (we:scripts/merge-ai-prs.mjs); test with that exact line. Related: #2669.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/__tests__/pr-merge-gate.test.mjs` passes, including new cases that fail RED on current `main`: an added line `"it.skip('x', () => {});"` (marker only inside a string) yields `tampered:false`.
- [A2] **Executable** — the same file still flags a real `+  it.skip('flaky', () => {});`, a wrapped `+  it.skip`, `.skip.each`, and bare `xit(`/`fit(` as `test-skipped` (no existing case regresses).
- [A3] **Must (bounded raw fallback)** — scan the ORIGINAL line for every backtick-containing line, an unterminated single/double quote, a possible regex/division slash, or an unclosed block comment (Test plan 2, 6, 9, 11). These are explicit conservative guards, not a guarantee that a per-line scanner can recognize every unparseable or ambiguous JS context.
- [A4] **Must (non-source inputs)** — stripping applies only to JS/TS test paths (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`); any other path under `__tests__/` (docs, config, data) is scanned raw as today.

## Non-goals

- [N1] No multi-line lexical tracking. Initial context is unknown in a per-added-line scan, so every line containing a backtick stays raw, including apparently complete single-line templates (Test plan 2, 11). Multi-line block comments and single/double quoted strings continued with an escaped newline remain explicit residual limitations: their closer-then-opener lines can still hide executable markers. This plan accepts those residuals and does not promise a general fail-closed JS lexer. No change to `TEST_CASE_OPENER_RE` or `tests-removed` counting. No full JS parser.

## Design

Premise check: still live. `scanTestTampering` (`we:scripts/lib/pr-merge-gate.mjs:~146`) tests each ADDED line against `SKIP_FOCUS_MARKER_RE` (`:95`) with no notion of strings, so `"it.skip('x', …)"` inside a fixture string matches (live #4717). The card's cited file `we:scripts/merge-ai-prs.mjs` only calls it (`:5485`); the fix belongs in `we:scripts/lib/pr-merge-gate.mjs`, so scope is corrected to that file plus its test. Related #2669 (regex tightening) is already landed and does not cover strings.

Add a pure helper `stripStringsAndComments(line)` next to the regex: first return the ORIGINAL line unchanged if it contains any backtick, before stripping strings or comments. A backtick may close a template opened on an earlier line; two backticks do not prove that the intervening text is string content. Otherwise make one left-to-right pass over the line tracking `'` and `"` with backslash escapes; string contents are replaced by nothing (quotes kept so `it.skip('x')` becomes `it.skip('')`, still a marker); `//` outside a string drops the rest of the line; a `/* … */` fully on the line is dropped. If a quote is still open at end of line, return the ORIGINAL line unchanged (A3). In the skip loop (`:149`), call it only when `isJsTestPath(f.path)` (A4), then test `SKIP_FOCUS_MARKER_RE` on the result. Comment-only lines without backticks like `// it.skip(` become empty and stop matching.

Raw-fallback rule (adversarial review): return the ORIGINAL line unchanged for any backtick (pre-check the entire line, including quotes and comments), a `/` encountered outside quotes/comments that is not part of `//` or `/*` (possible regex literal or division), or an unclosed `/*`. Template interpolation is covered by the backtick rule. Do not infer that a pair of backticks forms one complete template, or make fallback depend on the marker text or the first non-space character: a closer may follow other template-body text on the same line. A line is stripped only when it contains no backticks and the scan encounters only plain quotes, `//` and closed `/* */`. Unknown initial context from block comments or escaped-newline quoted strings remains a residual limitation (N1). A `\\` pair is consumed as one escape so `"a\\"; it.skip('x')` still closes the string and flags when the line starts outside a continued string.

## MVP

Musts: the helper (with the raw-fallback rule above), a new `isJsTestPath` helper (extension-based; only `isTestPath` exists today), the JS/TS-only gate, the skip-count change, and the tests below. Backtick stripping must remain disabled while initial lexical context is unknown; case 11 must pass before enabling the helper. Out: everything in Non-goals and Follow-ups.

## Test plan

In `we:scripts/__tests__/pr-merge-gate.test.mjs`:
1. string fixture `+  "it.skip('x', () => {});",` → `tampered:false` (RED today: counts 1, the #4717 line).
2. template fixture `` +  const s = `describe.only('a')`; `` → flagged raw (A3; accepted residual false positive).
3. line comment `+  // it.skip('x')` and trailing `+  run(); // xit(` → clean (RED today).
4. real `+  it.skip('flaky', () => {});` and `+  it.skip('a'); // note` → still `test-skipped` (guards over-stripping).
5. skip after a string on the same line: `+  foo('a'); it.skip('b')` → still flagged.
6. unterminated quote `+  it.skip('x` and `` +  const s = `it.only( `` → flagged raw (A3).
7. same string fixture in a non-JS file under `__tests__/` → flagged (A4, RED-neutral guard).
8. escaped quote `+  "a\" it.skip('x')"` → clean; and an escaped backslash that closes the string, source line `"a\\"; it.skip('x')` → flagged.
9. review-driven fail-closed guards (all flagged, i.e. scanned raw): a regex literal with `//` (`/\//.test(p); it.skip('x')`), a regex literal with a quote (`/'/; it.skip(x, ''); /'/`), a template interpolation (`` `${it.skip('x', () => {})}` ``), an unclosed `/* it.skip('a')`, and `/* don't */ it.skip('x')` and `it.skip('x') // don't` (code outside the comment still flagged).
10. the existing `midLineString` / `terminatedRef` cases (`we:scripts/__tests__/pr-merge-gate.test.mjs:~287`) stay clean.
11. `closingMultilineTemplateDoesNotHideSkip`: construct valid source with opening line "const a = " + backtick, middle line backtick + "; it.skip('x', () => {}); const b = " + backtick, and a closing-backtick line. Feed the corresponding added lines through `scanTestTampering`; assert `tampered:true` and a `test-skipped` finding. Also exercise a hunk that adds only the middle line (template boundaries are unchanged outside the hunk). Repeat with template-body text before the closing backtick, leading whitespace, `.only`, `.skip.each`, and bare `xit(`/`fit(`. All remain flagged raw. Include a variant with a backtick inside a quote/comment before the executable marker to pin that the backtick pre-check runs before any stripping.

Use this exact partial-hunk fixture for case 11; the context lines must not contribute to the added-marker count:

```diff
diff --git a/scripts/__tests__/template-boundaries.test.mjs b/scripts/__tests__/template-boundaries.test.mjs
--- a/scripts/__tests__/template-boundaries.test.mjs
+++ b/scripts/__tests__/template-boundaries.test.mjs
@@ -1,2 +1,3 @@
 const a = `
+`; it.skip('x', () => {}); const b = `
 `;
```

Assert exactly one `test-skipped` marker for this file as well as `tampered:true`. This isolates the closer-then-opener line: an implementation cannot pass merely by flagging an opening or closing context line.

Cases 2, 4-7 and 9-11 pass today and are guards; 1, 3 and the string half of 8 are the RED cases. Case 11 must fail under a mutation that removes the backtick pre-check and resumes per-line template stripping.

## Proof plan

Before/after on the live shape: run `scanTestTampering` on a diff whose added line is the exact #4717 text (`it.skip("x", () => {})` inside a fixture string in `we:scripts/lib/__tests__/merge-gate-ci.test.mjs`) via a `node -e` probe on `main` (expect `tampered:true`) and in the lane (expect `false`); paste both outputs in the PR body. Then run the full `pr-merge-gate` test file green.

For the review regression, require Test plan 11 to pass with the helper enabled and to turn RED with the backtick pre-check removed and the original per-line template stripping restored. The current raw detector already flags this line; a green run against the unmodified detector alone does not verify the proposed helper.

## Edge cases this change must handle

1. **Untrusted text** — the diff text is attacker-controlled: the stripper only deletes characters and never evals or builds a regex from the input; pin quote escapes (cases 5, 6, 8) and unknown template boundaries, including concatenated templates and partial hunks (case 11).
2. **Truncated reads** — n/a: pure function over a diff string already read by the caller; no `gh`/`git` read added.
3. **Shared state files** — n/a: no state written.
4. **Bounded raw fallback** — any backtick, an unterminated single/double quote, possible regex/division, an unclosed block comment, or a non-JS path keeps the original line (A3, A4; cases 2, 6, 7, 9, 11). No claim of full lexical fail-closed behaviour (N1).
5. **Identity scoping** — n/a: findings stay keyed by `f.path` as today.
6. **State over time** — n/a: stateless per call.
7. **Who wrote it** — n/a: the gate trusts no author; the PR's own diff is the only input.

## Follow-ups

- Establish lexical context from source/hunk boundaries before stripping templates or tracking block comments and escaped-newline quoted strings across lines; added lines alone cannot establish that context. Pin quoted-string continuation closer-then-opener regressions when addressing that residual, including a closing-quote line with a balancing quote inside a trailing comment (no trailing backslash required). Backtick fixture false positives remain accepted until then.
- Review prevention: a future `check:standards` card lint should require each Must/fail-closed claim to name its Test plan cases; the fallback claims here now name theirs.
- Same stripping for `TEST_CASE_OPENER_RE` if a string-embedded `it('` ever mis-counts a removal.

## Progress

- 2026-10-13 prepare: premise live on main (no string stripping in `scanTestTampering`, `we:scripts/lib/pr-merge-gate.mjs:149`). Scope corrected from `we:scripts/merge-ai-prs.mjs` (only the caller, `:5485`) to `we:scripts/lib/pr-merge-gate.mjs` + its test. Size 1 unchanged (one helper + one call site + tests).
- 2026-10-13 review repair (#5129): replaced per-line template stripping with an unconditional backtick raw pre-check; narrowed A3/N1 claims, accepted template-fixture false positives, and planned `closingMultilineTemplateDoesNotHideSkip` plus mutation proof (case 11). This prepare repair changes the plan; it does not implement the helper.
