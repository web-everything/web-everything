---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/settings/review.json"]
dateOpened: "2026-10-12"
tags: []
---

# Review proceeds when CI red is only inherited from main

Held finding 214 (2026-10-10; operator direction: reviews do not care about main broken test). A pure gate (we:scripts/conveyor/review-ci-gate.mjs) plus a 5-line we:scripts/conveyor/reconcile-core.mjs hook were built and tested on branch lane/review-ignores-inherited-red @ baa87ccda (stacked on #4797), never landed. Remaining: attach PR and main failing jobs/tests facts (we:scripts/conveyor/reconcile-pass.mjs or we:scripts/conveyor/main-ci-red-io.mjs publishing probe.failing), the second CI gate in we:scripts/operations/review-dispatch.mjs (~:599) and we:scripts/operations/review-job.mjs (~:583), settings in we:scripts/settings/review.json; draft promotion uses a separate path. Resume from that branch once the files held by #4773/#4777/#4792/#4797 are free. Not queued: blocked on those PRs.

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
