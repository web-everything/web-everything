---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/__tests__/reap-dead-review-runs.test.mjs"]
dateOpened: "2026-11-28"
tags: []
---

# Review follow-ups (round-budget, round 4) from web-everything/web-everything#7629

Filed mechanically by the unattended review loop: web-everything/web-everything#7629's review (reviewed head `0e012b5b5faeeaf6d9d303dff0431b5f6a557356`) (finding set `b6e34d917fe88b1f`) was accepted because round 4 is past the round budget K=3 and no finding is broken (card 5471). Each finding below was deferred to this card instead of another fix round:

1. `we:scripts/lib/__tests__/reap-dead-review-runs.test.mjs:366` — correctness, CONFIRMED degraded: The existing test 'session-reaper flag opts in to a dry-run and adds deadReviewRuns to JSON' fails on the PR head. session-reaper never passes 'dir'/'repo'/'probeContext', so the new 'missing-context' hold (we:reap-dead-review-runs.mjs:119) catches the run before the age check at line 130. The test sti

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
