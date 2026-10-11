---
kind: story
size: 3
status: resolved
priority: high
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs", "we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs", "we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-10-10"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Mechanical rounds never spend a review round

Live: #4631 head f0f4943fb refused cap-exhausted 6/5 after a mechanical conflict round. A conflict-watch bounce read as a review verdict and spent the takeover head's one review (we:scripts/conveyor/takeover-review.mjs). New we:scripts/conveyor/mechanical-round-cap.mjs: review.mechanicalRoundsCountTowardCap (default false, cascade standard > platform > repo > env, source logged); a git-proven mechanical head carries its parent's verdict on an identical net diff, or earns one review past the cap when only conflict hunks changed. Merge gate and review:human untouched.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs`: the #4631-shape case is red on the #4759 base (the conflict-watch bounce spends the takeover review) and green after. Also: a mechanical round does not increment the round count; an identical net diff carries the prior verdict; changed conflict hunks get exactly one review; a non-mechanical round stays capped.
- [A2] Must refuse on error: any git read failure, a non-merge head, a merged parent not on the base, or an edit in a file the base did not change → `proven: false` → the normal cap applies.
- [A3] Must not loosen the merge gate or `review:human`: a grant only dispatches a review (still behind CI and referral holds); a carried accept is applied by the accept carry-forward sweep (#4631), not here.

## Non-goals

- [N1] Rebase-mode (non-merge) mechanical rounds are not proven and stay capped. Non-WE repos get no git evidence (the reconcile pass reads git in the WE clone only).
- [N2] Applying a carried accept label — left to the accept carry-forward sweep (TODO pointer in reconcile-core).

## Edge cases this change must handle

1. **Untrusted text** — markers and verdicts count only from trusted authors (`isTrustedMarkerAuthor`); refnames are checked against a safe pattern and passed after `--end-of-options`.
2. **Truncated reads** — the comment thread is read whole by the existing PR read; an unreadable git read is `proven: false`.
3. **Shared state files** — n/a: no state file; the setting is read-only.
4. **Fail closed** — any unproven fact keeps the cap.
5. **Identity scoping** — facts are bound to the live head SHA; a fact for another head is `stale-facts`.
6. **State over time** — one review per mechanical head: once a verdict names the head (or lands after the round), it is capped again.
7. **Who wrote it** — a forged mechanical marker from an untrusted login grants nothing (tested).
