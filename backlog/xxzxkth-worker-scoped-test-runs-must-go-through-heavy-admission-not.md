---
kind: story
size: 3
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/operations/verify.mjs", "we:.claude/hooks"]
dateOpened: "2026-10-31"
tags: []
---

# Worker scoped test runs must go through heavy-admission, not bare npx vitest

Live 2026-10-31 10:35 ET: workers run scoped tests as bare 'npx vitest ...' and verify --gate='npx vitest related ...'. That skips heavy-admission, so nothing routes to Forge even with heavyAdmission.remote.mode=always: Mac load 69 while Forge ~1. Fix: we:scripts/worker-brief.mjs and verify --gate wrap test commands in 'node we:scripts/readiness/heavy-admission.mjs run -- <cmd>'; a hook could rewrite or deny bare vitest from a lane cwd.

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
