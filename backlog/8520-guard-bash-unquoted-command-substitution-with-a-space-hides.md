---
bornAs: xtap2wv
kind: story
size: 3
status: active
scaffoldedBy: "fix-6262"
dateScaffolded: "2026-11-04"
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-11-04"
tags: []
---

# guard-bash: unquoted command substitution with a space hides git from daemon-clone write protection

Found by the PR 6262 round-14 fix self-review (pre-existing, outside that fenced send-back). (1) Normalization: the tokenizer splits an unquoted $(...) containing a space, so the first word becomes `f)` and git is not recognized: `X=$(cat f) git -C <daemon clone> fetch origin main:main` and, with cwd in the clone, `X=$(true x) git reset --hard` are allowed. (2) A `read` of a non-target variable later used as a config source (`read X; export X; git -C <clone> --config-env=remote.origin.fetch=X fetch origin`, or `read XDG_CONFIG_HOME; export XDG_CONFIG_HOME; git -C <clone> fetch origin`) is not marked unknown, so the fetch-config reader fills it from the hook environment and the fetch is allowed. Fail closed: deny a git command whose leading assignment or config source cannot be resolved while a daemon clone is registered.

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
