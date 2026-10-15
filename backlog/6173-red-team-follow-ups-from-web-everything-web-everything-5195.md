---
bornAs: xdh8ns7
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-state.mjs", "we:scripts/lib/drain-ledger-facts.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5195 (head ae3a9f0f6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5195 (reviewed head `ae3a9f0f60cb9fe6b5b6312ff0cab257a6003799`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:
1. `we:scripts/lib/pr-state.mjs:105` — (failing-input, degraded) An exempt, green PR renders a changes-requested label
2. `we:scripts/lib/drain-ledger-facts.mjs:49` — (edge-case, degraded) Abbreviated acceptance coverage is never repaired but still blocks the gate

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #6152.

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
