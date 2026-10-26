---
bornAs: x3k3zqa
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A flake's root-cause fix loses priority once main turns green, and the flake re-reds main

[held entry 351] (coroner 2026-10-14, held) A flake's root-cause fix loses priority once main turns green, and the flake re-reds main. A3 sim (sim-scenario-self-sync-sibling) turned main red at 01:53, 07:33 and 12:14 ET. Its fix #5270 (opened 03:26 ET) was first held by the red-main freeze, then went through the normal loop: 16 fix dispatches, round 7, escalated, still open. Fix idea: a PR that fixes a test which turned main red 2 or more times in 24h keeps red-main-repair priority after main goes green (fixer slot, a review limited to the flake fix, an automatic round grant). The test stays quarantined until it lands (xx7ckd6). Evidence: main CI runs 38554537899, 38594041851; PR #5270 comments 10-15 01:12–06:19Z. Scope: we:scripts/conveyor health-watch red-main, fix priority. Size 2.

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
