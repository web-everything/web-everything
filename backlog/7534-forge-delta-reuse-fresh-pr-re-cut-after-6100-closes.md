---
bornAs: xzo459u
kind: task
parent: "7533"
status: open
scope: ["we:scripts/readiness/forge-exec-manifest.mjs", "we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# Forge delta-reuse: fresh PR re-cut after #6100 closes

After PR #6100 closes and card 7533 lands, re-cut the delta-reuse change on the merged tip. It must read projected memory leaves via sourcePath and pass the 15-row parity matrix in we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs (all 15 rows pass on the re-cut delta-reuse branch, including projected memory leaves read via sourcePath)`

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not start before PR 6100 is closed and card 7533 has landed.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input.
2. **Truncated reads** — n/a: no new read path.
3. **Shared state files** — n/a: no new shared state file.
4. **Fail closed** — n/a: the change only tightens or tests existing behavior; any failure keeps falling back to the full scan.
5. **Identity scoping** — n/a: no identity logic touched.
6. **State over time** — n/a: no persisted state added.
7. **Who wrote it** — n/a: no authorship signal touched.
