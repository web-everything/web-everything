---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/red-team-result-label-sync.mjs", "we:scripts/lib/red-team-result-schema.mjs", "we:scripts/__tests__/red-team-status-labels.test.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Red-team pipeline v2 slice 2: stale red-team:blocked refresh bound to the head that was blocked

Slice 1 (lane/redteam-pipeline-v2) dropped blocked->pending (R907 07:43 ET) after 3 audit rounds found demotion holes: any trusted older-head result was taken as proof, and the pre-write check did not re-test the demotion reason. Slice 2: record which head a red-team:blocked label was set for (gate record / label event), and demote to pending only when that exact head is no longer the live head, re-checked immediately before the write. Reader: we:scripts/lib/red-team-result-schema.mjs; writer: we:scripts/lib/red-team-result-label-sync.mjs. Live case: #6777 class of stale blocked labels.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/__tests__/red-team-status-labels.test.mjs`: a named test where blocked was recorded for head A, the live head is B with no result, and the sync refreshes blocked to pending; a second where blocked was recorded for the live head and stays blocked. Both fail before this item lands.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change blocked->clear (slice 1) or the not-owed / check-run writers (slice 3).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the blocked-head record is read only from a trusted gate marker (marker-authorship); comment text never proves a head moved.
2. **Truncated reads** — a capped or unreadable comment/label-event read keeps blocked.
3. **Shared state files** — the per-head status file is re-read under its lock right before the write; any change aborts.
4. **Fail closed** — no record of which head was blocked = keep blocked.
5. **Identity scoping** — the record must name this repo, PR and a full 40-hex head.
6. **State over time** — the demotion reason (blocked head != live head, no own/carried result) is re-tested after the evidence re-read, with the head read last before setLabels.
7. **Who wrote it** — only the red-team gate's own record (trusted author) names the blocked head.
