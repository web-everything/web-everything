---
bornAs: xp754ue
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
related: ["daemon-clone-gc-safety-gaps"]
---

# Overlay merges: we:scripts/ci/test-timings.json conflicts should auto-resolve

The advisory file we:scripts/ci/test-timings.json conflicts whenever an overlay branch and main both add timing entries, which blocked the fix daemon's clone-gc probe overlay (overlay-main-merge-conflict, 2026-11-15) and kept the discard loop alive. Overlay merges should resolve it automatically, by a union merge driver for the file or by regenerating it, so it never blocks a rebuild.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/daemon-overlay-merge.test.mjs` merges an overlay and main that both add soak timing entries and expects a clean merge with both entries present.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: no change to how timings are used by the test sharder.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only the advisory timings file is touched; other conflicts still stop the merge.
2. **Truncated reads** — n/a: only the advisory timings file is touched; other conflicts still stop the merge.
3. **Shared state files** — n/a: only the advisory timings file is touched; other conflicts still stop the merge.
4. **Fail closed** — n/a: only the advisory timings file is touched; other conflicts still stop the merge.
5. **Identity scoping** — n/a: only the advisory timings file is touched; other conflicts still stop the merge.
6. **State over time** — n/a: only the advisory timings file is touched; other conflicts still stop the merge.
7. **Who wrote it** — n/a: only the advisory timings file is touched; other conflicts still stop the merge.

## Duplicate admission

the clone-gc probe overlay was blocked by this conflict

no card covers merge-driver or regeneration of the advisory timings file for overlay merges

## Added 2026-11-15 (cards batch 20)

2026-11-15 17:04 ET MED: apply the same test-timings advisory auto-resolve to the behind-main-conflict path in we:scripts/operations/prototype-load-io.mjs (the #6905 auto-resolve covers only the first path).
