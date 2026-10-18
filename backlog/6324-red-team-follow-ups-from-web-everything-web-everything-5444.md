---
bornAs: x3faq3e
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-seat-settings.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5444 (head 2762ba577)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5444 (reviewed head `2762ba577a93c3d78edc1bd9641e817684f450dd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-seat-settings.mjs:133` — (failing-input, degraded) Object-valued safeguard settings bypass scalar validation and enable unwanted shadows
   - Scenario: Set shadowSeats.antigravity.enabled to {"value":false}, with no environment override. A read-only probe of resolveReviewSeatSafeguards returned shadowEnabled:{"value":false} and invalid:[], and seatProviderDirective emitted a live shadow directive for a high-care PR. The cascade validates nested booleans instead of rejecting the enclosing object; admission then treats that object as truthy. The same defect accepts scope:{"value":"high-care"} and, with enabled:true, admits routine PR o/r#15 through sampling. Object-valued scalar settings should be rejected and logged, preserving the lower-layer
   - Claude's re-check: Confirmed by trace. project() passes an object like {value:false} through unchanged. resolveCascade's leaves() flattens it to path ['shadowEnabled','value'], and check() validates only path[0]'s predicate against the nested false, so it passes. setLeaf then overwrites the standard shadowEnabled=false with {value:false}, and invalid stays empty. shadowSeatStatus tests '!policy.shadowEnabled', which is false for an object, so the shadow is admitted. scope {value:'high-care'} fails '=== 'high-care'' and falls to the sampled branch, which admits PRs by sampleRate.

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
