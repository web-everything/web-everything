---
bornAs: xvk9y0r
kind: story
size: 3
status: open
scope: ["we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/lib/prevention-landing-job.mjs", "we:scripts/lib/red-team-gate.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Two gate runs for the same PR both act (duplicate follow-up card, duplicate send-back ledger event, duplicate…

Flow-sim gap B-C2, class K7 (unserialized duplicate actors). Failing input: Labels: review:accepted. Comments: trusted result on HEAD with a confirmed `degraded` finding (card action) or `broken` finding; no gate marker yet. No lock file; status file irrelevant. review-job's post-red-team gate (we:review-job.mjs:1011) and an extend-rounds re-gate (we:extend-rounds-io.mjs:18) or an operator CLI run (we:… Cited: we:scripts/operations/red-team-gate-apply.mjs:140-148, we:scripts/lib/prevention-landing-job.mjs:84, we:scripts/lib/red-team-gate.mjs:352-357. Soak-break sketch: double-act (two follow-up cards for one result; duplicate SEND_BACK ledger events; duplicate round-cap notifications)

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
