---
bornAs: xj2vlfj
kind: story
size: 2
status: open
scope: ["we:worker-brief.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Workers run scoped tests as bare `npx vitest ...` (and verify --gate="npx vitest related ...") → bypasses heav

HIGH priority hint. - [HIGH 2026-10-31 10:35 ET] Workers run scoped tests as bare `npx vitest ...` (and verify --gate="npx vitest related ...") → bypasses heavy-admission → never routes to Forge even with mode=always; Mac load 69 while Forge ~1. we:worker-brief.mjs + verify --gate must wrap test commands in `node we:scripts/readiness/heavy-admission.mjs run -- a placeholder-named file`; a hook could rewrite/deny bare vitest from lane cwd.

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
