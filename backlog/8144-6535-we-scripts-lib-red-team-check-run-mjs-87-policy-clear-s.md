---
bornAs: xf95agh
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-check-run.mjs"]
dateOpened: "2026-11-09"
tags: []
---

# #6535 we:scripts/lib/red-team-check-run.mjs:87 policy-clear supersede race — addressed by #6606's host-local publication lock (R800 single-host scope)

Card for the #6535 referral finding at we:scripts/lib/red-team-check-run.mjs:87 (policy-clear publication can supersede a concurrently started red-team round with success). Ruled under R787 (card it with a ruledWeakened exception) and R800 (single-host scope); the race is addressed by #6606's host-local publication lock.

## Acceptance

- [A1] **Executable** — n/a: record-only card. The fix is #6606's host-local publication lock; this card records the R787 `card` ruling (with ruledWeakened exception) and the R800 single-host scope for the #6535 referral finding.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No code change here; multi-host publication races are out of scope (R800 single-host scope).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: record-only card, no code path changes.
2. **Truncated reads** — n/a: record-only card, no code path changes.
3. **Shared state files** — n/a: record-only card, no code path changes.
4. **Fail closed** — n/a: record-only card, no code path changes.
5. **Identity scoping** — n/a: record-only card, no code path changes.
6. **State over time** — n/a: record-only card, no code path changes.
7. **Who wrote it** — n/a: record-only card, no code path changes.
