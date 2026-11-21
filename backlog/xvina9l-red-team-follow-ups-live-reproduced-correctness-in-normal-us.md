---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/prototype-load-io.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7227 (head fb151f85c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7227 (reviewed head `fb151f85cb98d721716b5af9017d92f8f16e5fc0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/prototype-load-io.mjs:769` — (edge-case, degraded) Pending hot-patch readiness records block subsequent admission of the same SHA
   - Scenario: Request a hot patch while CI is pending, which persists tests:'pending'. Let it unload and settle after an evidence outage, then retry the same still-open PR after CI becomes green. The singleton permits retry, but readyEvidence rejects the persisted pending record and the loader returns no-ready/no-fix-ready-record at line 591 before reading current CI. Admission should refresh provisional readiness from current evidence so the unchanged patch can be loaded again.
   - Class: live-reproduced (basis: Executed the actual createPrototypeLoader and readiness helpers in memory with filesystem/reservation stubs, an empty unsettled-load ledger, the pending record produced by this change, and a successful current-CI reader. Observed no-ready/no-fix-ready-record and zero CI-reader calls. Dependencies were unavailable, so the complete CLI lifecycle was not executed.)
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
