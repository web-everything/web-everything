---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/hotpatch-readers.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7466 (head 68a3959e3)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7466 (reviewed head `68a3959e3000eaaaa4574e6bfa93fc700cf11dc2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/hotpatch-readers.mjs:32` — (edge-case, degraded) The API budget accumulates across admissions, permanently exhausting reused readers.
   - Scenario: Create one reader instance and repeatedly call admitHotpatch with identical complete green evidence matching the current 10-unit, 5-integration, 8-soak matrix. The first three admissions pass, using 27, 53 and 79 cumulative API calls. The fourth returns unknown at 100 calls; subsequent admissions remain unknown without executing API reads. The counter belongs to the reader closure and never resets. Each admission should receive its own bounded budget so previously accepted, unchanged evidence continues to pass.
   - Class: live-reproduced (basis: Reproduced using the actual exported production readers and admission guard, the checked-out CI matrix, and injected Git/API/file responses. Only the transport wrapper was bypassed to prevent external calls and writes. The source explicitly supports reader reuse, and its tests already exercise repeated admissions.)
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
