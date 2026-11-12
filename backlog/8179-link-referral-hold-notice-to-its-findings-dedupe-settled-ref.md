---
bornAs: xn6wqwb
kind: story
size: 3
status: open
dateOpened: "2026-11-12"
tags: []
related: ["6719"]
---

# Link referral hold notice to its findings; dedupe settled-referral-pause helper

1) review-referral-hold notice should carry run/key linkage so settled-hold checks prove finding identity, not counts (we:scripts/lib/settled-referral-pause.mjs, we:scripts/operations/pr-sweep-core.mjs). 2) we:scripts/lib/settled-referral-pause.mjs duplicates isSettledReferralPauseNotice in we:scripts/lib/review-red-team-on-skip.mjs; merge into one shared helper once PRs 6606/6601/6535 land.

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

## Duplicate admission

round-judge-missing-verdict residual (R895+R903): equal-count auto-policy rulings could mask a newer unsaved hold; helper duplicated from we:scripts/lib/review-red-team-on-skip.mjs

no existing card links hold notices to run/key or dedupes isSettledReferralPauseNotice
