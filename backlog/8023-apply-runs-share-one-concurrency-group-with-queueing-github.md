---
bornAs: x9vq7im
kind: story
size: 2
status: open
scope: ["we:scripts/collect-review-requests.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Apply runs share one concurrency group with queueing; GitHub keeps only ONE pending run, so a middle push's r…

Flow-sim gap R7b-G3, class K3 (one-shot step, no re-driver). Failing input: Run R1 (push P1) is in progress (npm ci, apply loop, ledger push takes minutes). Two sessions each stage a verdict: push P2 (we:10-accepted.json) then push P3 (we:11-changes.json) while R1 still runs. 'P3's run enters the concurrency group; P2's run is still pending. Cited: we:scripts/collect-review-requests.mjs:98, we:scripts/collect-review-requests.mjs:22-25. Soak-break sketch: Workflow-level: assert the workflow file has no bare concurrency group for a diff-by-push consumer (parse YAML; fail unless the collect step lists the whole directory minus a ledger of applied requests, or concurrency uses a per-ref/per-sha group). Unit: coll…

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
