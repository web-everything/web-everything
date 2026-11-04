---
bornAs: xb90l5k
kind: story
size: 2
status: open
scope: ["we:.github/workflows/hetzner-jobs.yml"]
dateOpened: "2026-11-02"
tags: []
---

# Longshore CI runners on the Hetzner box

MED priority hint. - (held 2026-10-26 19:09 ET, operator) Longshore CI runners on the Hetzner box: plan it under split epic #5488 once the public/private line (#5410, A/B/C) is ruled and the repo exists. If Longshore is public, use the WE rules (merge_group/main only, selected-workflow pin to a reusable we:hetzner-jobs.yml@main, outside-contributor approval, separate runner user). If it is private, use the plateau rules. Not now.

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
