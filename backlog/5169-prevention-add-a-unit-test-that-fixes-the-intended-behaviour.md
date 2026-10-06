---
bornAs: xmssc37
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/infra-cancelled.mjs", "we:scripts/conveyor/__tests__/infra-cancelled.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a unit test that fixes the intended behaviour for a cancelled job with a runner and steps. Be… (from web-everything/web-everything#4024 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/infra-cancelled.mjs:28` — Add a unit test that fixes the intended behaviour for a cancelled job with a runner and steps. Better, narrow main-red infra judgement to cancelled jobs with no runner or no started step, or correlate against GitHub's outage window. File this as a backlog item.
2. `we:scripts/conveyor/infra-cancelled.mjs:64` — Add a deterministic classifier regression test covering an aggregate with a genuinely failed dependency alongside an unrelated cancellation, including cancellations in another run; require dependency evidence before suppressing the aggregate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4024@2bd3fa79327a9641d3d99707d29b5602214fa723

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
