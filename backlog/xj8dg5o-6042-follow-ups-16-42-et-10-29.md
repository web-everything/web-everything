---
kind: story
size: 2
status: open
scope: ["we:rollup-collapse.mjs", "we:red-main-quarantine-io.mjs", "we:coroner-rounds.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #6042 follow-ups (16:42 ET 10-29)

LOW priority hint. - [LOW] #6042 follow-ups (16:42 ET 10-29): (a) a completed failure with no timestamp ranks below an older dated success (fix broke 25 id-tie-break tests; needs design); (b) we:rollup-collapse.mjs, we:red-main-quarantine-io.mjs, we:coroner-rounds.mjs still order by run_attempt/id, not the R216 ranking.

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
