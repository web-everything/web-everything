---
bornAs: xyhht5l
kind: story
size: 5
status: open
related: ["4399"]
scope: ["we:scripts/lib/prevention-landing-job.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/review-set-label.mjs", "we:scripts/lib/review-loop-policy.mjs", "we:scripts/operations/land-prevention-card.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# review-loop prevention / round-cards card accepted on 'queued' only; landing job failure leaves no card, no r…

Flow-sim gap E-G5, class K3 (one-shot step, no re-driver). Failing input: review-pr run parks at confirm with prevention-outstanding or round-cards decision; filer is fileItemForPreventionViaLandingJob' 'detached land-prevention-card job fails after spawn (lane exhaustion, red gate, refused PR) or is killed Cited: we:scripts/lib/prevention-landing-job.mjs:75-123, we:scripts/operations/review-loop-cli.mjs:196-207, we:scripts/operations/review-loop-cli.mjs:864-865, we:scripts/review-set-label.mjs:995, we:scripts/lib/review-loop-policy.mjs. Soak-break sketch: PR accepted (and may merge) with the debt recorded nowhere. The land-prevention-card header says failures are 'BEST-EFFORT, LOGGED, NEVER RETRIED' (:49).

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
