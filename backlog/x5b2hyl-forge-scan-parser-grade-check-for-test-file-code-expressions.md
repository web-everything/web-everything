---
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/forge-exec-manifest.mjs", "we:scripts/readiness/__tests__/forge-exec-manifest.test.mjs"]
dateOpened: "2026-11-09"
tags: []
---

# Forge scan: parser-grade check for test-file code expressions (R824/R825 residual)

Reinforce later. The Forge credential scan skips test-file name:value code expressions (R824), so a plain quoted high-entropy literal beside a call, e.g. creds: f('<40 random chars>'), passes in a test file. Add a parser-grade check or an allowlist of fixture shapes. Known token patterns must keep always hitting.

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
