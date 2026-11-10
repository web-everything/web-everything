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

- [A1] **Executable** — `npm run test:unit -- we:scripts/readiness/__tests__/forge-exec-manifest.test.mjs` with a new test named `flags a high-entropy argument inside a test-file credential call`: a test-file `creds: f('<40 random chars>')` is flagged (assertion: `credentialContentFinding` returns `high-entropy-creds`). Today `we:scripts/readiness/__tests__/forge-scan-code-expression.test.mjs` pins this as a ruled residual (returns null), so flipping that pin is the change.
- [A2] **Executable** — same command, a table-driven test named `flags an unquoted high-entropy value beside a call or arrow in a test file`: `creds: <40 random chars>(x)` and `creds: <40 random chars> => x` in a test file are flagged. Both shapes are pinned today by `pins the ruled test-file residual` in `we:scripts/readiness/__tests__/forge-scan-code-expression.test.mjs`.

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
