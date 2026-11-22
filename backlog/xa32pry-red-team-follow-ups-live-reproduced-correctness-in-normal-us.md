---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/build-priority-set-io.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7349 (head aaf708911)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7349 (reviewed head `aaf70891178afcd66d2fc5e9023ae9f39a0b5022`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/build-priority-set-io.mjs` — (edge-case, degraded) Automatic selection admits directory scopes covering plateau-app’s protected drain daemon.
   - Scenario: Use --auto-count=1 --mode=only --ttl-hours=2 --actor=operator --reason=probe with priority list ['42'], no open PRs, and card 42 having status open, size 2, and scope ['plateau:tools/**']. The planner selects 42 with no skipped entries, although this scope covers we:tools/drain-daemon/lib.mjs, a registered trust-chain file. Protected homes retain the 'plateau-app/' prefix while the candidate path becomes 'tools/**', so their intersection is missed. The card should be skipped; with no other candidates, selection should refuse.
   - Class: live-reproduced (basis: Executed the actual operation’s planning step with injected card, priority-list and PR readers. It selected 42. Separate probes confirmed that the scope covers the existing protected file, isTrustChainPath recognizes that file, and the selector’s comparison against its prefixed home returns false. Naming the protected file directly was refused.)
   - Also class: correctness-in-normal-use
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
