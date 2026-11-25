---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7476 (head 836ae47a1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7476 (reviewed head `836ae47a18b5f8b583d59b943dc3e74bda299d3b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle.mjs:2243` — (edge-case, degraded) Nested wrapper/shim calls count the same secondary-limit response twice.
   - Scenario: Call runGhSync(['api', 'user']) through the shim with maxAttempts=1 and return status 1 with stderr 'gh: You have exceeded a secondary rate limit. (HTTP 403)'. The shim records the response at line 2548, then the parent records the propagated failure again at line 2244. One network response produces currentHour=2 and last60Min=2; a direct shim call produces 1 for both. Count each actual secondary-limit response once so operator telemetry reflects actual hits.
   - Class: live-reproduced (basis: Reproduced using the exported APIs, an injected subprocess executor, and in-memory filesystem interception. The wrapper propagated its actual GH_OUTER_INV_ENV marker to the shim; one simulated network response yielded two persisted timestamps.)
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
