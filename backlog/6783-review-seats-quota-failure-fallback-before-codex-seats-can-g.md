---
bornAs: xuybrvq
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Review seats: quota-failure fallback before Codex seats can gate verdicts

The daily cap is 80/provider/day (`PROVIDER_CAP_DEFAULT` in `we:scripts/operations/review-extra-seats.mjs`) against ~280 calls/day. Once Codex seats are verdict seats (decision 6784), a quota hit must not stall verdicts.

## Acceptance

- [A1] **Executable** — new unit tests in the review-extra-seats test file: when the Codex quota is exhausted for a verdict lens, the seat falls back to a Claude seat for that lens, or degrades to advisory with a logged reason; both fail before and pass after.
- [A2] **Executable** — a test proves a quota hit never yields a silent pass: the verdict record shows the fallback or the degrade reason.

## Non-goals

- [N1] Does not raise the cap or change cap accounting.
- [N2] Does not promote any seat; that is decision 6784.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no new text parsing; provider error strings are matched, never executed.
2. **Truncated reads** — a quota error with a truncated body is still treated as a quota failure (fail closed).
3. **Shared state files** — the per-day counter is shared; concurrent seats must not both pass the cap check.
4. **Fail closed** — unknown provider errors count as a failed seat and never as a pass.
5. **Identity scoping** — counter is per provider; the Claude fallback counts against the Claude provider.
6. **State over time** — the counter resets at the day boundary (ET); a fallback seat started before reset is not retried.
7. **Who wrote it** — fallback seats are labelled with their real provider in the verdict record.
