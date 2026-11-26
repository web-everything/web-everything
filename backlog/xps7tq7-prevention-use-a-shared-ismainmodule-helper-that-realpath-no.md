---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/audit-nonconvergence.mjs", "we:scripts/operations/__tests__/audit-nonconvergence.test.mjs", "we:docs/operations/audit-nonconvergence.md"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Use a shared isMainModule helper that realpath-normalizes both sides, enforced by a lint rule. Al… (from web-everything/web-everything#7541 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/audit-nonconvergence.mjs:163` — Use a shared isMainModule helper that realpath-normalizes both sides, enforced by a lint rule. Alternatively, have the CLI test spawn through a symlink.
2. `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs:189` — Add an injected-stderr test whose write throws and asserts exit code 2. Longer term, add a check that each doc guarantee phrase maps to a named test.
3. `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs:252` — Replace the regex with a deterministic allowlist test. Parse the module's imports and require them to be a subset of {node:fs, node:path, node:url}, and restrict `fs.*` member use to openSync, readSync, closeSync. This is the scope of the carded AUDIT-NONCONVERGE-SCAN-GUARD.
4. `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs:253` — Scan the whole repo, including .github, shell and yaml, for the literal basename `audit-nonconvergence` outside the allowed files. For JS use an AST or whole-file multiline match. This is the scope of the carded AUDIT-NONCONVERGE-SCAN-GUARD.
5. `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs:93` — Add a table-driven negative test over every root and provenance field, and run a mutation-testing pass over validate().
6. `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs` — Add the named deterministic regression test asserting the original recommendation sequence after a second qualifying streak.
7. `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs` — Add a deterministic failure-matrix test covering failure of both the primary output and fallback reporting channels.
8. `we:scripts/operations/audit-nonconvergence.mjs:44` — Add a table-driven canonical_repository_names_are_accepted test covering .github and leading underscore/hyphen repository names.
9. `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs` — Add deterministic scanner regression fixtures for synchronous filesystem writes, multiline imports, and supported module extensions; use parsed imports and an explicit adapter allowlist.
10. `we:docs/operations/audit-nonconvergence.md:98` — Add stderr_failure_cannot_restore_success to the existing diagnostic suite, covering synchronous and asynchronous stderr errors after stdout failure.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7541@2d15455fe452a7e319ad6c330f6b08ea9cc76d12

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
