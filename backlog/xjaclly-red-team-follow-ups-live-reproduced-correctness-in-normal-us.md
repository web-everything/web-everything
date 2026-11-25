---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7494 (head d49d8c081)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7494 (reviewed head `d49d8c0818f70969b44be7012dbaeddd3099eafe`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-queue-safety.mjs:772` — (edge-case, degraded) Shadow logging suppresses the chain refusals it needs to measure
   - Scenario: Supply same-name, same-commit GitHub Actions checks from run 201: job 21 fails at 12:01, removal occurs at 12:02, then job 11 starts at 12:03 and succeeds at 12:04. Default inspection confirms the flake; maxFailures 3 correctly refuses the ID/time disagreement but returns no failures field. Consequently, !at3.failures suppresses the shadow token entirely. The default retry should report actual=confirmed at3=hold. This omission hides precisely the ordering incompatibility the shadow is intended to reveal before raising the setting.
   - Class: live-reproduced (basis: A read-only Node probe executed the actual inspectMqReruns export and observed default confirmed=true, at3 refusal with failures undefined, and the shadow suppression predicate evaluating true. The public guard probe could not run because markdown-it is absent; token suppression follows directly from the changed expression.)
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
