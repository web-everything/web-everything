---
bornAs: xgftdj5
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/lib/fix-executor-chain.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# aiRouting PR2 residuals: fix-chain strength rule and a warning on resolver fallback

2026-11-15 17:55 ET (aiRouting PR2 residuals): (a) the fix chain from aiRouting is not strength-checked, e.g. [codex-alt, codex, claude] is accepted; decide a strength order/rule for writer chains (design call). (b) an aiRouting fix-chain resolver error silently falls back to the default chain; emit one warning/event so a bad operator setting is visible.

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
