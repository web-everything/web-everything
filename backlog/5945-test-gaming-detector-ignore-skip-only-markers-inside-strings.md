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
- [A3] **Must (refuse on error)** — a line the stripper cannot confidently parse (unterminated quote or template at end of line) is scanned RAW, so it still counts; the loosening never turns an unparseable line into "clean".
- [A4] **Must (non-source inputs)** — stripping applies only to JS/TS test paths (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`); any other path under `__tests__/` (docs, config, data) is scanned raw as today.

## Non-goals

- [N1] No multi-line template-literal or block-comment tracking (the scan is per added line; a fixture spanning lines still counts, which is the safe side). No change to `TEST_CASE_OPENER_RE` or `tests-removed` counting. No full JS parser.

## Design

Premise check: still live. `scanTestTampering` (`we:scripts/lib/pr-merge-gate.mjs:~146`) tests each ADDED line against `SKIP_FOCUS_MARKER_RE` (`:95`) with no notion of strings, so `"it.skip('x', …)"` inside a fixture string matches (live #4717). The card's cited file `we:scripts/merge-ai-prs.mjs` only calls it (`:5485`); the fix belongs in `we:scripts/lib/pr-merge-gate.mjs`, so scope is corrected to that file plus its test. Related #2669 (regex tightening) is already landed and does not cover strings.

Add a pure helper `stripStringsAndComments(line)` next to the regex: one left-to-right pass over the line tracking `'`, `"`, `` ` `` with backslash escapes; string contents are replaced by nothing (quotes kept so `it.skip('x')` becomes `it.skip('')`, still a marker); `//` outside a string drops the rest of the line; a `/* … */` fully on the line is dropped. If a quote is still open at end of line, return the ORIGINAL line unchanged (fail closed, A3). In the skip loop (`:149`), call it only when `isJsTestPath(f.path)` (A4), then test `SKIP_FOCUS_MARKER_RE` on the result. Comment-only lines like `// it.skip(` become empty and stop matching.

Raw-fallback rule (adversarial review, fail closed): return the ORIGINAL line unchanged whenever the line holds anything the one-pass scanner can misread — a `/` that is not part of `//` or `/*` (possible regex literal or division), a template body containing `${`, or an unclosed `/*`. A line is stripped only when it is plain quotes, `//` and closed `/* */`. This keeps the helper tiny and means a regex or interpolation can never hide a real marker; the cost is that such lines keep counting, the safe side. A `\\` pair is consumed as one escape so `"a\\"; it.skip('x')` still closes the string and flags.

## MVP

Musts: the helper (with the raw-fallback rule below), a new `isJsTestPath` helper (extension-based; only `isTestPath` exists today), the JS/TS-only gate, the skip-count change, and the tests below. Out: everything in Non-goals and Follow-ups.

## Test plan

In `we:scripts/__tests__/pr-merge-gate.test.mjs`:
1. string fixture `+  "it.skip('x', () => {});",` → `tampered:false` (RED today: counts 1, the #4717 line).
2. template fixture `` +  const s = `describe.only('a')`; `` → clean (RED today).
3. line comment `+  // it.skip('x')` and trailing `+  run(); // xit(` → clean (RED today).
4. real `+  it.skip('flaky', () => {});` and `+  it.skip('a'); // note` → still `test-skipped` (guards over-stripping).
5. skip after a string on the same line: `+  foo('a'); it.skip('b')` → still flagged.
6. unterminated quote `+  it.skip('x` and `` +  const s = `it.only( `` → flagged raw (A3).
7. same string fixture in a non-JS file under `__tests__/` → flagged (A4, RED-neutral guard).
8. escaped quote `+  "a\" it.skip('x')"` → clean; and an escaped backslash that closes the string, source line `"a\\"; it.skip('x')` → flagged.
9. review-driven fail-closed guards (all flagged, i.e. scanned raw): a regex literal with `//` (`/\//.test(p); it.skip('x')`), a regex literal with a quote (`/'/; it.skip(x, ''); /'/`), a template interpolation (`` `${it.skip('x', () => {})}` ``), an unclosed `/* it.skip('a')`, and `/* don't */ it.skip('x')` and `it.skip('x') // don't` (code outside the comment still flagged).
10. the existing `midLineString` / `terminatedRef` cases (`we:scripts/__tests__/pr-merge-gate.test.mjs:~287`) stay clean.
Cases 4-7 and 9-10 pass today and are guards; 1-3 and the string half of 8 are the RED cases.

## Proof plan

Before/after on the live shape: run `scanTestTampering` on a diff whose added line is the exact #4717 text (`it.skip("x", () => {})` inside a fixture string in `we:scripts/lib/__tests__/merge-gate-ci.test.mjs`) via a `node -e` probe on `main` (expect `tampered:true`) and in the lane (expect `false`); paste both outputs in the PR body. Then run the full `pr-merge-gate` test file green.

## Edge cases this change must handle

1. **Untrusted text** — the diff text is attacker-controlled: the stripper only deletes characters and never evals or builds a regex from the input; hiding a real marker behind a quote trick must not work (cases 5, 6, 8).
2. **Truncated reads** — n/a: pure function over a diff string already read by the caller; no `gh`/`git` read added.
3. **Shared state files** — n/a: no state written.
4. **Fail closed** — an unterminated string/template on a line, or a non-JS path, is scanned raw (A3, A4; cases 6, 7).
5. **Identity scoping** — n/a: findings stay keyed by `f.path` as today.
6. **State over time** — n/a: stateless per call.
7. **Who wrote it** — n/a: the gate trusts no author; the PR's own diff is the only input.

## Follow-ups

- Track template literals and block comments across added lines (multi-line fixtures still count today).
- Same stripping for `TEST_CASE_OPENER_RE` if a string-embedded `it('` ever mis-counts a removal.

## Progress

- 2026-10-13 prepare: premise live on main (no string stripping in `scanTestTampering`, `we:scripts/lib/pr-merge-gate.mjs:149`). Scope corrected from `we:scripts/merge-ai-prs.mjs` (only the caller, `:5485`) to `we:scripts/lib/pr-merge-gate.mjs` + its test. Size 1 unchanged (one helper + one call site + tests).
