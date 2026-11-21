---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/forge-key-structure.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7228 (head 06065c041)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7228 (reviewed head `06065c041ae5957757d7a08c9da4b88619296a08`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/forge-key-structure.mjs:83` — (edge-case, degraded) Repeated line-comment openers cause quadratic scanning outside the work budget
   - Scenario: Scan Buffer.from("{//".repeat(80000)+"kty"). Every brace triggers startsObjectMember, whose afterTrivia call searches the remaining suffix for a line ending. Each search fails before reaching tick(), bypassing the step budget. This 240,003-byte input took 7.3 seconds through credentialBufferFinding and another 7.3 seconds through manifestEntry before admission. A 900,003-byte variant with 300,000 repetitions exceeded a 10-second subprocess timeout. The scan should run in bounded linear time or promptly return budget exhaustion instead of blocking admission synchronously.
   - Class: live-reproduced (basis: Read-only Node probes measured 125, 494, and 1,824 ms for 10,000, 20,000, and 40,000 repetitions, demonstrating quadratic growth. Reproduced through both production admission hooks; the larger probe was terminated by its explicit timeout.)
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
