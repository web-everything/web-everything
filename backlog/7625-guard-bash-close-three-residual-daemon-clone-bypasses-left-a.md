---
bornAs: x2pny1p
kind: story
size: 3
status: open
scope: ["we:scripts/guard-bash.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# guard-bash: close three residual daemon-clone bypasses left after the first daemon-clone fix

HIGH. Residual bypasses found after PR 6262 (none loosen an existing deny) in we:scripts/guard-bash.mjs: (1) a refspec shaped user@host:other after the remote is misread as a URL; (2) fetch refspecs stored in the clone's git config are not read, so treat any fetch in a daemon clone without an explicit safe refspec as head-writing unless config is proven; (3) git config and git remote writes in a daemon clone are not denied; deny them (config write plus fetch chain).

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
