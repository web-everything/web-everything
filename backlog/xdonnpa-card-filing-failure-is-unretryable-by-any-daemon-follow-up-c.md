---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/extend-rounds-io.mjs", "we:scripts/lib/red-team-status-labels.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Card filing failure is unretryable by any daemon (follow-up card lost, label clear)

Flow-sim gap B-C9, class K3 (one-shot step, no re-driver). Failing input: Result on HEAD with only `degraded`/class-card findings. io.fileCard returns {ok:false} (spawn failed, gh shim guard refusal in daemon context we:prevention-landing-job.mjs:~80). gate returns 'card-failed' (:219) and records nothing, by design 'stays retryable'. Cited: we:scripts/operations/red-team-gate-apply.mjs:216-219, we:scripts/operations/review-job.mjs:1011, we:scripts/operations/extend-rounds-io.mjs:71, we:scripts/lib/red-team-status-labels.mjs:21-23. Soak-break sketch: stuck (silent loss of the card; PR proceeds with red-team:clear)

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
