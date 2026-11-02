---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# The fix-dispatch claim lease (10 min) is shorter than the real fix-daemon sweep interval (7–14 min), so anothe

HIGH priority hint. - [HIGH] The fix-dispatch claim lease (10 min) is shorter than the real fix-daemon sweep interval (7–14 min), so another dispatcher can reclaim a live claim between sweeps. Same root cause as the #6048 idle-clock miss: the code assumes 2-min sweeps. Fix: derive the lease and idle bounds from the measured sweep cadence (10-29 08:11 ET). - #6048 follow-up: converge was replaced by a single Codex adversarial review. A real converge run is owed before review.

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
