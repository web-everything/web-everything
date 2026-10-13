---
bornAs: x4q84y2
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/pass-timings.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Drain pass: stop a pass blocking on queue-merged follow-ups and per-PR branch prep (~350s/pass)

Card 257 follow-on (coroner 2026-10-12): the drain pass spends ~2-7 min per pass (2026-10-13 timings: listing 16-42s, classifyGateReads 14-44s, mergeCascade 52-120s; one pass 409s) and the coroner attributed ~350s/pass to waiting on merges landing. Card 257 (we:scripts/lib/enqueue-on-event.mjs) removed that wait from the ready-to-enqueued path by running a single-PR fast drain between passes, but the pass itself still serializes the queue-merged post-land follow-ups (we:scripts/lib/drain-merge-strategy.mjs collectQueueMerged) and per-PR numbering-before-enqueue inside mergeCascade (we:scripts/merge-ai-prs.mjs). Not cleanly separable inside card 257's scope: it needs a per-step attribution of the 350s first (pass-timings has no sub-step for follow-ups vs branch prep), then moving the blocking part out of the pass (the x4y74wj detached follow-up job is the precedent). Also observed: an enqueue refused with 'already in the queue' is counted as a failed land (exit 2), which triggers the full backoff for every PR.

## Acceptance

- [A1] **Executable** — a pass-timings unit test proves the pass reports separate sub-steps for queue follow-ups and branch prep, and a daemon history row after landing shows mergeCascade without the follow-up time.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the enqueue gate or the event-driven single-PR path (card 257).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: timings and PR numbers only.
2. **Truncated reads** — a follow-up read failure keeps the entry pending (today's rule).
3. **Shared state files** — the follow-up state file stays written under the land lock.
4. **Fail closed** — a detached follow-up that fails stays pending and retries; it never drops numbering.
5. **Identity scoping** — n/a: per-repo, keyed as today.
6. **State over time** — follow-up attempt cap stays as today.
7. **Who wrote it** — n/a: drain-internal state only.
