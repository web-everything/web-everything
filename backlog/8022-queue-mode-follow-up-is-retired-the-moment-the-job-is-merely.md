---
bornAs: x3f0fj4
kind: story
size: 3
status: open
related: ["5919"]
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/daemon-jobs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Queue-mode follow-up is retired the moment the job is merely enqueued, so a job that later exhausts its attem…

Flow-sim gap R8a-G2, class K3 (one-shot step, no re-driver). Failing input: PR #P was enqueued in GitHub's merge queue (state.pending entry, followUpAttempts 0), drainFollowupJob=on (we:scripts/settings/drain-followup-job.json). GitHub merges it. Next pass: collectQueueMerged returns the entry and adds it to merged / landedThisPass; handOffDrainFollowup enqueues the job and the pass sets handedOff=true… Cited: we:scripts/lib/drain-merge-strategy.mjs:664-710, we:scripts/merge-ai-prs.mjs:7461, we:scripts/merge-ai-prs.mjs:7679, we:scripts/lib/drain-merge-strategy.mjs:720-728, we:scripts/lib/drain-merge-strategy.mjs:685. Soak-break sketch: Fixture: queue state with one pending PR whose gh view is MERGED; follow-up setting on; a job store whose job for it ends status failed. Action: run the pass, then a second pass. Assert (fails today): the entry is still in state.pending (or a retry job is que…

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
