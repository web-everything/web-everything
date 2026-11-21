---
kind: story
size: 2
status: active
scaffoldedBy: "fix-7227"
dateScaffolded: "2026-11-21"
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/__tests__/urgent-verify.test.mjs"]
dateOpened: "2026-11-21"
tags: []
related: ["7227"]
---

# urgent-verify system-tool PATH probe trips the hermetic guard when the gh-shim dir is on PATH

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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

local verify of PR 7227 went red on 20 urgent-verify tests: we:scripts/operations/urgent-verify.mjs (main 0323a3bfdb) accessSyncs every PATH dir for git/node/npm/sh; the verify host PATH includes the github-app-token gh-shim dir, which the hermetic guard flags as live GitHub access. Passes 323/323 with the shim dir stripped from PATH. Fix: inject a systemPath fixture in the test or skip shim dirs.

backlog 4183 is resolved and covers other host-state leaks
