---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/lane-repair.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-08"
tags: []
---

# Clone repair: run re-clone before the safety gates for a clone whose HEAD is gone

Follow-up from #4402 review (operator approved with follow-up 2026-10-08). In we:scripts/lib/daemon-rebuild/prepare.mjs repairCloneRefs runs in Step 2, after findUnsafeLocalState and HEAD verification already return terminal (status-failed / head-unresolved) for a clone whose HEAD object is missing or index is corrupt, so the only re-clone-enabled path never re-clones it. Move the repair ahead of the safety gates under the lock, and add a prepareRebuild-level test with a HEAD-object-missing clone expecting reason clone-recloned.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
