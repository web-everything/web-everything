---
kind: story
size: 3
status: active
scaffoldedBy: "fix-7170"
dateScaffolded: "2026-11-20"
scope: ["we:scripts/lib/agent-launch.mjs"]
dateOpened: "2026-11-20"
tags: []
related: ["7170"]
---

# agent-launch git config filter ignores file-scope transport policy

childGitConfig judges tightening only against Git built-in defaults and the parent env. With no env transport policy, a caller can add remote-probe protocol.<x>.allow=always pins or protocol.file.allow=user, which override a global or system protocol.allow=never set in a config file. Not reachable with today's config (global config has no protocol keys). Fix: consult the effective file-scope protocol policy (git config --get-regexp ^protocol) or drop non-never transport pairs unless the caller proves no file-scope policy.

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

follow-up variant found in PR 7170 self-review

PR 7170 covers env-scope pairs only
