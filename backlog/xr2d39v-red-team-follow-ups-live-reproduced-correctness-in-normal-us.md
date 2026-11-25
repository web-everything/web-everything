---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/delivery-strategy.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, attacker-same-user] from web-everything/web-everything#7492 (head 22ca63f9c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7492 (reviewed head `22ca63f9c656ffd0396ea4571a3df567b7107390`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/delivery-strategy.mjs:211` — (failing-input, degraded) Record validation rejects supported epoch-second observation timestamps.
   - Scenario: Take the first replay candidate, set every observedAt to 1795604400 and at to 1795608000, and construct a complete, correctly pinned record from select's output. Selection returns prototype-first, but decisionFindings reports every observation time absent because nonEmpty only accepts strings. Equivalent ISO timestamps produce no findings. Record validation should accept the timestamp representation supported by selection.
   - Class: live-reproduced (basis: Reproduced directly with Node using the checked-out selector and fixtures; equivalent ISO and unmodified records passed validation.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/delivery-strategy.mjs:163` — (edge-case, degraded) An accepted table can mask the security floor with an earlier hold.
   - Scenario: Clone the shipped table and change R6.rank to 0. tableFindings returns no findings. With fresh security-open=true and loads-stalled-stage=true observations, select returns hold/STALLED_GATE instead of unhandled/SECURITY_FLOOR. The validator checks security precedence only against strategy-producing rows. It should reject a table that permits another outcome to intercept an open security finding, or selection should enforce the floor first.
   - Class: live-reproduced (basis: Observed empty table findings and the masked result in Node. The original table returned SECURITY_FLOOR for the same inputs. This demonstrates incorrect selector output, not a live delivery-gate bypass.)
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
