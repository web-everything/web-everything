---
bornAs: xgtyzj1
kind: story
size: 3
status: open
scope: ["we:scripts/operations"]
dateOpened: "2026-10-25"
tags: []
---

# Status and sweep answers come from one declared operation listing every open PR with its mover

coroner 2026-10-22: the operator corrected the orchestrator's status claims 14 times in 54 h, mostly about sweep gaps (#5485 said paused when not caught by the sweep; '#5530 not picked up by our sweeps'; PRs stuck for hours). Want: one operation lists every open PR with mover and last-movement age and flags any PR with no mover; the orchestrator quotes it instead of composing prose; the PR sweep gets a 'no mover for N hours' check. Evidence: coroner assistant section, corrections at 10-21 06:52, 08:38, 09:47 ET.

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
