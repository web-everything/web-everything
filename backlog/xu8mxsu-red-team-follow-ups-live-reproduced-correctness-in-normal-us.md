---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/seat-assessment.mjs", "we:scripts/lib/seat-ac-rubric.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7363 (head c69fec0d8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7363 (reviewed head `c69fec0d84e634c85286dc5cf09bc5f350e3e312`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/seat-assessment.mjs:54` — (failing-input, degraded) Bare repro evidence produces a correctness pass without proof
   - Scenario: Load the published live/7236-correctness assessment, rubric and policy. Replace each answer's evidence with [{"kind":"repro"}] and evaluate with matching head/run bindings. The probe returned derived=pass, gateOutcome=pass and no problems, with zero immutable evidence reads. Evidence without a citation, reference or reproducible result should yield not-pass.
   - Class: live-reproduced (basis: Observed through evaluateSeat using the PR's fixtures and actual validator. The orchestrator remains unwired, so this demonstrates incorrect library/shadow results rather than a current merge-admission bypass.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/seat-ac-rubric.mjs:22` — (failing-input, degraded) Multiline acceptance criteria lose their substantive requirements
   - Scenario: Pass we:backlog/8584-daemon-host-gate-reinforce-kill-the-daemon-process-group-on.md through acceptanceItems. A1 becomes only '**Executable** — run the scoped unit-test command for', omitting the test path and process-liveness requirements. A3 likewise loses the requirements forbidding cache reads and writes. buildAcceptanceRubric therefore supplies incomplete criteria to correctness reviewers. It should retain each item's continuation lines.
   - Class: live-reproduced (basis: A read-only Node probe against the PR parser reproduced truncation of all four acceptance items in an existing repository card. This affects the pinned rubric before assessment or future gate activation.)
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
