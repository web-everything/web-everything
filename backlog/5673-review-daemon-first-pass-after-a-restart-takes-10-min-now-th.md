---
bornAs: xbf7be9
kind: story
size: 3
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Review daemon first pass after a restart takes ~10 min — now the whole promote-to-review wait

After card 5658 a promoted draft's review goes out in the same review-daemon pass, so the remaining wait is pass length. Live 2026-10-09: steady pass 2-5 min (pr-events wake 20:22:12Z -> session-reap 20:24:21Z), but after the self-sync restart at 20:33:41Z the first pass only finished at 20:43:27Z (~10 min), so #4683/#4680 (promoted 20:26:43Z) waited 16.7 min. Card 4218 owns the rebuild smoke starving ticks (smoke-slow 305 s at 20:33:39Z); this card owns the cold first pass (ledger-shadow store pending, pr-facts warm, reconcile over all repos) — measure per-step timing on the first pass (see 4129) and cut it below one steady pass.

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
