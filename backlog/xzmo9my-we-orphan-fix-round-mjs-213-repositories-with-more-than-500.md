---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# we:orphan-fix-round.mjs:213 Repositories with more than 500 open PRs now lose all orphan-guard processing on every pas (web-everything#7429)

1. `we:scripts/conveyor/orphan-fix-round.mjs:213` — Repositories with more than 500 open PRs now lose all orphan-guard processing on every pass.

Operator card follow-up for web-everything/web-everything#7429 (head a3f98058848d63fe6f9989974f4cd5bee6a72df9).

Not worse than main (R903): main listed only the newest 200 PRs (--limit 200) and silently ignored older bounced PRs; the PR lists 500 and fails closed above that; real repo has far fewer than 500 open PRs

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
