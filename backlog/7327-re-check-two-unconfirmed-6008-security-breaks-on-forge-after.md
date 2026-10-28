---
bornAs: x9k2ott
kind: task
status: open
scope: ["we:scripts/forge-exec-run.mjs", "we:scripts/remote-exec.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Re-check two unconfirmed #6008 security breaks on Forge after install

2026-10-28 10:01 ET. #6008 red-team (e9d03968f9) raised 2 UNCONFIRMED security breaks: we:scripts/forge-exec-run.mjs:285 git deps may run prepare scripts during the inert install; we:scripts/remote-exec.mjs:129 source-parent symlink swap may disclose excluded files. Re-check both on Forge (real npm git-dep behaviour with --ignore-scripts; symlink race test).

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
