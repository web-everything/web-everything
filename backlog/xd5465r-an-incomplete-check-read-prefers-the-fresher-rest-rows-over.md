---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# An incomplete check read prefers the fresher REST rows over the stale snapshot

Follow-up from the #3432 advisory (operator approved #3432, 2026-10-02). we:scripts/conveyor/reconcile-pass.mjs:1022: when hydration is refused as incomplete, the stale truncated snapshot red or pending verdict overrides the fresher REST rows, which are discarded, so a PR can look red after it turned green and get an unneeded CI heal. Apply the known snapshot only when the read errored; for an incomplete read, merge or prefer the REST rows. Test: a snapshot with a CANCELLED check and REST rows holding its later success reads green.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
