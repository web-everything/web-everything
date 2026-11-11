---
bornAs: x5b2hyl
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/forge-exec-manifest.mjs", "we:scripts/readiness/__tests__/forge-exec-manifest.test.mjs", "we:scripts/readiness/__tests__/forge-scan-code-expression.test.mjs"]
dateOpened: "2026-11-09"
tags: []
---

# Forge scan: parser-grade check for test-file code expressions (R824/R825 residual)

Reinforce later. The Forge credential scan skips test-file name:value code expressions (R824), so a plain quoted high-entropy literal beside a call, e.g. creds: f('<40 random chars>'), passes in a test file. Add a parser-grade check or an allowlist of fixture shapes. Known token patterns must keep always hitting.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/readiness/__tests__/forge-exec-manifest.test.mjs` with a new test named `flags a high-entropy argument inside a test-file credential call`: a test-file `creds: f('<40 random chars>')` is flagged (assertion: `credentialContentFinding` returns `high-entropy-creds`). The residual pin is flipped. Landed with this PR: a quoted or unquoted token that is long and either digit-bearing or very high entropy keeps the scan; word-like fixtures (`'ghp_acceptance_fixture'`) and long identifiers still skip. Pieces of a split secret are joined (call names and keywords dropped) before the same test. Mid-entropy random tokens (3.5-4.3 bits, under three digits: lowercase, mixed case, hex digests) no longer read as words: inside a test-file code expression a 20+ character token also keeps the scan unless it is word-shaped (two or more letters-only segments split at whitespace, `_`, `.`, `:`, `-` and camelCase humps, none with a 4-consonant run, at most one without a vowel), and a 20+ character hex run with three or more digits always keeps it. Checked against all 2,205 repo test files: no file changes outcome. Known gaps, left to a real parser: a random string whose bare literal scores under 3.5 bits (the base scan flags it only through the surrounding call characters) still reads as a non-secret, a pronounceable random token (consonant-vowel syllables, e.g. several 5-8 letter syllable words joined by `-` or camelCase) reads as words and passes, and URLs or absolute paths in a test-file call keep the scan (a 4-consonant run, fail closed), and a secret cut by whitespace into unquoted pieces under 20 characters passes the ruled whitespace exemption.
- [A2] **Executable** — same command, a table-driven test named `flags an unquoted high-entropy value beside a call or arrow in a test file`: `creds: <40 random chars>(x)` and `creds: <40 random chars> => x` in a test file are flagged. Landed with this PR; the shapes are also table-tested in `we:scripts/readiness/__tests__/forge-scan-code-expression.test.mjs`.

- [A3] **Executable** — same command, test `flags a test-file credential value that is only a parenthesized literal` (in `we:scripts/readiness/__tests__/forge-scan-code-expression.test.mjs`): a bare paren or a keyword before a paren (`return (`, `typeof (`, `await (`) around a literal is flagged; an arrow or a real identifier call still skips. Landed with this PR.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Changing the ruled R824 skip for non-test files or known token patterns.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: scan-policy tightening only; inherits the existing scan handling.
2. **Truncated reads** — n/a: scan-policy tightening only; inherits the existing scan handling.
3. **Shared state files** — n/a: scan-policy tightening only; inherits the existing scan handling.
4. **Fail closed** — n/a: scan-policy tightening only; inherits the existing scan handling.
5. **Identity scoping** — n/a: scan-policy tightening only; inherits the existing scan handling.
6. **State over time** — n/a: scan-policy tightening only; inherits the existing scan handling.
7. **Who wrote it** — n/a: scan-policy tightening only; inherits the existing scan handling.
