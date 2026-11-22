---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/provider-rotation-shadow.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7356 (head c3afac7b5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7356 (reviewed head `c3afac7b50172d059b438c192e332727e807a755`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/provider-rotation-shadow.mjs:30` — (failing-input, degraded) Build-only capacity allowlists prevent shadow picks for review, audit, and judge dispatches
   - Scenario: Pass audit, judge, or review-security rows through the observer's live-capacity projection using the shipped provider-capacity settings and fresh, healthy observations at 20% usage. Audit and judge return no-eligible-arm; review-security with a complete Codex builder returns no-cross-vendor-seat. The identical observations successfully pick for build. The configured allowedKinds exclude these observer kinds for every provider, so these dispatches cannot collect actual-versus-shadow comparisons. The integration needs capacity eligibility appropriate to these dispatch kinds.
   - Class: live-reproduced (basis: A read-only Node probe exercised appendRotationShadow with the shipped policy and provider definitions, injected fresh capacity observations, and a captured append. No daemon execution or routing change was assumed.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/provider-rotation-shadow.mjs:62` — (failing-input, degraded) Production review rows lack the complete builder identity required by the observer
   - Scenario: Observe the red-team row shape emitted by completeRedTeam: dispatchKind review-seat, lens red-team, and builder containing provider, model, taskType, and source, without effort. Even with ample injected cross-vendor capacity, the observer returns unknown-builder-family and shadowPick null. Adding builder.effort high produces a successful Claude pick. Ordinary buildSeatRows security rows omit builder entirely and return inconsistent-builder-family. Producers must supply the required identity so normal review runs can generate shadow comparisons while retaining the cross-vendor guard.
   - Class: live-reproduced (basis: Read-only Node probes reproduced both refusals and the successful complete-builder control. Production row construction was verified in we:review-extra-seats.mjs: buildSeatRows omits builder, and completeRedTeam adds builder without effort.)
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
