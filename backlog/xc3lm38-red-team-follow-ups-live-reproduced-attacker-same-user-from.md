---
kind: story
size: 2
status: open
scope: ["we:scripts/backlog-move/cli.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user] from web-everything/web-everything#7312 (head 002c8763a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7312 (reviewed head `002c8763a991220d3465f5e80b722f665d1011ee`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/backlog-move/cli.mjs:61` — (edge-case, degraded) A successful single-card plan can exceed status's manifest limit
   - Scenario: Plan one card, we:backlog/083-card.md, with 10,000 inbound cards named we:backlog/xN-reference-reference-reference-reference-reference-reference-reference-reference-reference-reference-card.md, each containing See #083. With unchanged source evidence and an empty destination listing, plan exits 0 and emits 1,330,022 bytes. Passing those exact bytes to status throws 'Manifest bound exceeded; use a smaller batch'. All plan bounds are satisfied, and the batch already contains one card. Successful plan output should remain consumable by status, or plan should explicitly refuse the oversized result befor
   - Class: live-reproduced (basis: Executed the exported main function with injected Git/GitHub fixtures and passed its exact printed output to status through io.read; observed plan exit 0 followed by the manifest-size exception.)
   - Also class: attacker-same-user
   - Claude's re-check: demonstrated break

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
