---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/extend-rounds-io.mjs", "we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Gate step never re-applied after a lost or failed run (confirmed break held forever, no fixer, no operator as…

Flow-sim gap B-C1, class K3 (one-shot step, no re-driver). Failing input: PR open, labels: review:accepted (+ ready-to-merge), red-team:blocked. Comments: one trusted `<!-- we:red-team-advisory pr=N rev=HEAD -->` with a '[**confirmed**] (broken?...)' finding; NO `we:red-team-gate` marker for it. Status file for HEAD: {status:'finished', result:{status:'ran', comment:'posted'}}. The gate process did n… Cited: we:scripts/operations/red-team-gate-apply.mjs:140-149, we:scripts/operations/review-job.mjs:587-598, we:scripts/operations/extend-rounds-io.mjs:18, we:scripts/lib/review-red-team-on-skip.mjs:330-334, we:scripts/lib/drain-queue-safety.mjs:467-468. Soak-break sketch: stuck. label red-team:blocked via disposition (no gate record keeps the break held) but no review:changes is ever written, no round-cap record, no needs-you item. Nothing re-runs the gate until a new head or an operator extend-rounds.

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
