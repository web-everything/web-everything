---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/provider-rotation-shadow.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7356 (head dc11b2bf2)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7356 (reviewed head `dc11b2bf255967cb27122f0d06b6c5d27886e95c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/provider-rotation-shadow.mjs:30` — (failing-input, degraded) Shipped capacity allowlists prevent shadow picks for review, audit, and judge dispatches
   - Scenario: Call the observer for review-security, audit, or judge with the shipped policy, complete builder identity, and healthy capacity observations. capacityEligibility receives the rotation kind, but the shipped provider-capacity allowedKinds contain only builder work. Review returns no-cross-vendor-seat; audit and judge return no-eligible-arm. A control changing only allowedKinds produces successful picks. Shadow capacity projection must support these dispatch kinds through the appropriate eligibility rules.
   - Class: live-reproduced (basis: Read-only Node probes exercised the actual observer and capacity projection with shipped defaults and healthy, account-attributed observations. Controls isolated allowedKinds as the cause.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/provider-rotation-shadow.mjs:86` — (failing-input, degraded) Real review producers do not supply the complete builder triple required by shadow draws
   - Scenario: Pass a red-team row shaped exactly like we:review-extra-seats.mjs produces: dispatchKind review-seat, lens red-team, and builder containing provider codex, model gpt-6.1-sol, taskType, and source. Even with explicitly eligible capacity, the observer records unknown-builder-family and no pick because builder.effort is absent. Adding effort high makes the same probe succeed. Ordinary buildSeatRows review rows omit builder entirely. The wiring must supply valid builder evidence from these producers so real key-seat observations can succeed.
   - Class: live-reproduced (basis: A Node probe reproduced the refusal using the production red-team builder shape and succeeded when only builder.effort was added. Source inspection confirms that the real producer omits effort and ordinary review-seat rows omit builder.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/provider-rotation-shadow.mjs:68` — (failing-input, degraded) Advisory judge scorecards lack the subject required for any shadow pick
   - Scenario: A normal codexJudgeSpawn advisory run calls recordCodexRunScorecard without item or handle; that recorder also supplies no repo or pr. The new observer maps advisory-review to judge, derives subject null, and drawArm refuses invalid-input even with eligible capacity. The probe reproduced this refusal. Thread the judged PR or card identity into the observation so advisory runs receive a deterministic subject and an attributable shadow pick.
   - Class: live-reproduced (basis: The actual observer rejected a production-shaped advisory row with invalid-input under injected eligible capacity. The codexJudgeSpawn call and run-quality-record recorder confirm that the live path supplies no usable subject.)
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
