---
bornAs: xg7mm5f
kind: story
size: 2
status: active
scaffoldedBy: "fix-6595"
dateScaffolded: "2026-11-09"
scope: ["we:scripts/__tests__/drain-verdict.test.mjs", "we:.github/workflows/drain-verdict.yml"]
dateOpened: "2026-11-09"
tags: []
related: ["6595"]
---

# drain-verdict: test assertSafeEnv against env names captured from a real Actions run

The drain-verdict credential guard (forbiddenCredential) is a blocklist of name patterns over env names the runner image controls. PR 6595 fixed _PAT matching GITHUB_PATH and added a hand-typed runner env fixture. Replace that fixture with names captured from a real ubuntu-latest run step (env | cut -d= -f1, names only) and assert assertSafeEnv accepts them, so the next image change that adds a matching name is caught in tests rather than by every shadow run failing.

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

## Duplicate admission

prevention owed by the PR 6595 advisory finding (_PAT matched GITHUB_PATH)
