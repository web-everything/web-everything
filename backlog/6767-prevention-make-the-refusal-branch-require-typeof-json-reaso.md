---
bornAs: xq1bapv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Make the refusal branch require typeof json.reason === 'string', or check enqueueOutcomes/toMerge… (from web-everything/web-everything#5256 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:181` — Make the refusal branch require `typeof json.reason === 'string'`, or check `enqueueOutcomes`/`toMerge` first. Add a summarizeFastDrain test fed the real result shape with `ok:false` and a recorded outcome.
2. `we:scripts/lib/enqueue-on-event.mjs:520` — Count a miss only for `verified === false` or `kind` in {batching-deferred, merge-lock-held}. Prune `misses` against the candidate listing each catch-up. Add a test that a revalidation abort does not increment `misses()`.
3. `we:scripts/merge-ai-prs.mjs:6545` — Add a source-contract test, in the style of we:drain-merge-strategy.test.mjs, asserting the `enqueueOutcomes.push` sites and the `enqueued === false` branch. Better, extract a pure `recordEnqueueOutcome(landLock)` helper and test it directly.
4. `we:scripts/merge-ai-prs.mjs:6577` — Add a deterministic producer-to-summary regression gate that exercises deferred admission, held locks, and refused preparation, asserting the emitted JSON and non-enqueue summary; require it in CI.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5256@6548b76609a81b00ce7fcaa7aff6f90d7b6eaa07

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
